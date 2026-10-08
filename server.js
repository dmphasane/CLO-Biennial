import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { v2 as cloudinary } from 'cloudinary';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { pool, query } from './db.js';
import { makeTransport, sendEmail, buildStatementHTML, buildRegistrationConfirmationHTML } from './email.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Global crash guards ───
// Keep the process alive if an async error slips through anywhere. Without these,
// a single unhandled rejection (e.g. a transient DB/email error) would crash the
// whole server and every user would get 503 until Render restarts it.
process.on('unhandledRejection', (reason)=>{ console.error('UNHANDLED REJECTION:', reason); });
process.on('uncaughtException', (err)=>{ console.error('UNCAUGHT EXCEPTION:', err); });

// ─── Auto-initialise database on startup (schema + seed users) ───
async function autoInitDb(){
  try{
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(schema);
    const users = [
      { username:'treasurer', name:'Ms Given Phusoane', role:'Treasurer', pass: process.env.TREASURER_PASSWORD || 'Treasurer@2027' },
      { username:'financial_secretary', name:'Mr Dumisani Mphasane', role:'Financial Secretary', pass: process.env.FINSEC_PASSWORD || 'FinSec@2027' },
      { username:'recording_secretary', name:'Ms Poppy Kareli', role:'Recording Secretary', pass: process.env.RECSEC_PASSWORD || 'RecSec@2027' },
    ];
    for(const u of users){
      const hash = await bcrypt.hash(u.pass, 10);
      await pool.query(
        `INSERT INTO users (username, password_hash, full_name, role) VALUES ($1,$2,$3,$4)
         ON CONFLICT (username) DO UPDATE SET password_hash=$2, full_name=$3, role=$4`,
        [u.username, hash, u.name, u.role]
      );
    }
    console.log('Database auto-init complete (schema + users).');
  }catch(e){
    // Log the FULL error — AggregateError (Supabase pooler) has a blank .message,
    // so surface the code, the nested errors, and the stack to diagnose it.
    console.error('DB auto-init failed. name=', e && e.name, 'code=', e && e.code, 'message=', e && e.message);
    if(e && e.errors && Array.isArray(e.errors)){
      e.errors.forEach((sub,i)=>console.error('  sub-error['+i+']:', sub && sub.code, sub && sub.message));
    }
    if(e && e.stack) console.error(e.stack);
  }
}

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

// ─── Cloudinary config ───
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ─── Middleware ───
app.use(cors({ origin: process.env.FRONTEND_URL || '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public'))); // serves the frontend

// Explicit root route → serve index.html (admin portal)
app.get('/', (req, res)=>{
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Clean, shareable registration links (no .html) → serve the registration form
app.get(['/register', '/join', '/signup'], (req, res)=>{
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});
app.get('/register-remote', (req, res)=>{
  res.sendFile(path.join(__dirname, 'public', 'register-remote.html'));
});

// Rate limit auth endpoint
const authLimiter = rateLimit({ windowMs: 15*60*1000, max: 20 });

// ─── Auth helpers ───
function signToken(user){
  return jwt.sign({ id:user.id, username:user.username, name:user.full_name, role:user.role }, JWT_SECRET, { expiresIn:'12h' });
}
function authRequired(req, res, next){
  const h = req.headers.authorization||'';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if(!token) return res.status(401).json({ error:'Not authenticated' });
  try{ req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch(e){ return res.status(401).json({ error:'Invalid or expired token' }); }
}
async function logAudit(user, action, detail){
  try{ await query('INSERT INTO audit_log (user_name, role, action, detail) VALUES ($1,$2,$3,$4)', [user?.name||'System', user?.role||'', action, detail]); }
  catch(e){ console.error('audit log failed', e.message); }
}

// ─── AUTH ───
const TEST_MODE = String(process.env.TEST_MODE||'').toLowerCase() === 'true';

app.post('/api/login', authLimiter, async (req, res)=>{
  const { username, password } = req.body;
  try{
    const r = await query('SELECT * FROM users WHERE username=$1', [username]);
    if(!r.rows.length) return res.status(401).json({ error:'Invalid credentials (user not found)' });
    const user = r.rows[0];
    // TEST MODE: skip password check (set TEST_MODE=true in Render env while testing)
    if(!TEST_MODE){
      const ok = await bcrypt.compare(password, user.password_hash);
      if(!ok) return res.status(401).json({ error:'Invalid credentials (wrong password)' });
    }
    await logAudit(user, 'Login', TEST_MODE ? 'User signed in (TEST MODE)' : 'User signed in');
    res.json({ token: signToken(user), user:{ name:user.full_name, role:user.role, username:user.username } });
  }catch(e){ console.error('LOGIN ERROR:', e); res.status(500).json({ error:'Server error: '+(e.message||e) }); }
});

// Debug: how many users are seeded (no secrets exposed)
app.get('/api/debug/users', async (req, res)=>{
  try{
    const r = await query('SELECT username, full_name, role FROM users ORDER BY username');
    res.json({ count:r.rows.length, users:r.rows });
  }catch(e){ res.status(500).json({ error:String(e.message||e) }); }
});

// Debug: force re-seed users (safe to call; updates passwords from env vars)
app.post('/api/debug/reseed', async (req, res)=>{
  try{
    await autoInitDb();
    const r = await query('SELECT username FROM users');
    res.json({ ok:true, userCount:r.rows.length });
  }catch(e){ res.status(500).json({ error:String(e.message||e) }); }
});

// Debug: test the Gmail connection and optionally send a test email.
// Usage: GET /api/debug/email-test?to=someone@example.com
app.get('/api/debug/email-test', async (req, res)=>{
  const to = req.query.to;
  const info = {
    provider: process.env.BREVO_API_KEY ? 'brevo' : (process.env.GMAIL_APP_PASSWORD ? 'smtp' : 'none'),
    brevoKeySet: !!process.env.BREVO_API_KEY,
    senderEmail: process.env.GMAIL_USER || 'nedloregistration@gmail.com',
  };
  if(!to){ return res.json({ ok:true, note:'Add ?to=you@example.com to send a test email', ...info }); }
  const result = await sendEmail({
    to,
    subject: 'NEDLO email test',
    text: 'This is a test email from the NEDLO Stokvel server. If you received this, email sending works.',
    html: '<p>This is a test email from the <strong>NEDLO Stokvel server</strong>. If you received this, email sending works.</p>',
  });
  res.status(result.ok?200:500).json({ ...result, sentTo:to, ...info });
});

// ─── MEMBERS ───
app.get('/api/members', authRequired, async (req, res)=>{
  const r = await query('SELECT * FROM members ORDER BY conference_code, full_name');
  res.json(r.rows.map(rowToMember));
});
app.post('/api/members', authRequired, async (req, res)=>{
  const m = req.body;
  await query(
    `INSERT INTO members (id,full_name,conference_code,local_church,email,phone,accommodation_option,
       expected_monthly_total,expected_accom,expected_reg,payment_ref,registration_date,ledger,cohort,last_statement_sent_at,district,last_statement_channel)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (id) DO UPDATE SET full_name=$2,conference_code=$3,local_church=$4,email=$5,phone=$6,
       accommodation_option=$7,expected_monthly_total=$8,expected_accom=$9,expected_reg=$10,payment_ref=$11,
       ledger=$13,cohort=$14,last_statement_sent_at=$15,district=$16,last_statement_channel=$17,updated_at=now()`,
    [m.id, m.fullName, m.conferenceCode, m.localChurch, m.email, m.phone, m.accommodationOption,
     m.expectedMonthlyTotal, m.expectedAccom, m.expectedReg, m.paymentRef, m.registrationDate, JSON.stringify(m.ledger||{}), m.cohort||'legacy', m.lastStatementSentAt||null, m.district||null, m.lastStatementChannel||null]
  );
  await logAudit(req.user, 'MemberSave', m.paymentRef);
  res.json({ ok:true });
});
app.delete('/api/members/:id', authRequired, async (req, res)=>{
  await query('DELETE FROM members WHERE id=$1', [req.params.id]);
  await logAudit(req.user, 'MemberDelete', req.params.id);
  res.json({ ok:true });
});

// ─── ENTRIES ───
app.get('/api/entries', authRequired, async (req, res)=>{
  const r = await query('SELECT * FROM entries ORDER BY txn_date DESC');
  res.json(r.rows.map(rowToEntry));
});
app.post('/api/entries/bulk', authRequired, async (req, res)=>{
  const entries = req.body.entries||[];
  const client = await pool.connect();
  try{
    await client.query('BEGIN');
    for(const e of entries){
      // Guard against resurrecting purged duplicates: if an entry with the SAME
      // fingerprint already exists under a DIFFERENT id, update that existing row
      // instead of inserting a new (duplicate) one.
      let targetId = e.id;
      if(e.fingerprint){
        const ex = await client.query('SELECT id FROM entries WHERE fingerprint=$1 LIMIT 1', [e.fingerprint]);
        if(ex.rows.length){ targetId = ex.rows[0].id; }
      }
      await client.query(
        `INSERT INTO entries (id,txn_date,val_date,description,reference_raw,reference_norm,credit_amount,
           contrib_month,match_status,linked_member_id,allocated_accom,allocated_reg,resolved_by,resolved_at,fingerprint,upload_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (id) DO UPDATE SET match_status=$9,linked_member_id=$10,allocated_accom=$11,
           allocated_reg=$12,resolved_by=$13,resolved_at=$14,contrib_month=$8,fingerprint=$15,upload_id=$16`,
        [targetId,e.txnDate,e.valDate,e.description,e.referenceRaw,e.referenceNorm,e.creditAmount,
         e.contribMonth,e.matchStatus,e.linkedMemberId,e.allocatedAccom,e.allocatedReg,e.resolvedBy,e.resolvedAt,e.fingerprint||null,e.uploadId||null]
      );
    }
    await client.query('COMMIT');
    await logAudit(req.user,'EntriesBulk',`Saved ${entries.length} entries`);
    res.json({ ok:true, count:entries.length });
  }catch(e){ await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error:e.message }); }
  finally{ client.release(); }
});
app.delete('/api/entries', authRequired, async (req, res)=>{
  await query('DELETE FROM entries');
  await logAudit(req.user,'ClearEntries','All entries cleared');
  res.json({ ok:true });
});

// ─── REF ALIASES ───
app.get('/api/aliases', authRequired, async (req, res)=>{
  const r = await query('SELECT * FROM ref_aliases');
  const map = {};
  r.rows.forEach(row=>{ map[row.ref_norm] = row.member_ids || row.member_id; });
  res.json(map);
});
app.post('/api/aliases', authRequired, async (req, res)=>{
  const { refNorm, memberId, memberIds } = req.body;
  await query(
    `INSERT INTO ref_aliases (ref_norm, member_id, member_ids) VALUES ($1,$2,$3)
     ON CONFLICT (ref_norm) DO UPDATE SET member_id=$2, member_ids=$3`,
    [refNorm, memberId||null, memberIds?JSON.stringify(memberIds):null]
  );
  res.json({ ok:true });
});

// ─── UPLOAD HISTORY ───
app.get('/api/uploads', authRequired, async (req, res)=>{
  const r = await query('SELECT * FROM uploads ORDER BY uploaded_at DESC');
  res.json(r.rows.map(rowToUpload));
});
app.post('/api/uploads', authRequired, async (req, res)=>{
  const u = req.body;
  await query(
    `INSERT INTO uploads (id,filename,uploaded_at,uploaded_by,row_count,imported,duplicates_skipped,credits_added,from_date,to_date,statement_total_entered)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (id) DO UPDATE SET filename=$2,uploaded_by=$4,row_count=$5,imported=$6,
       duplicates_skipped=$7,credits_added=$8,from_date=$9,to_date=$10,statement_total_entered=$11`,
    [u.id, u.filename, u.uploadedAt||new Date().toISOString(), u.uploadedBy, u.rowCount||0, u.imported||0,
     u.duplicatesSkipped||0, u.creditsAdded||0, u.fromDate||null, u.toDate||null, u.statementTotalEntered||0]
  );
  res.json({ ok:true });
});
app.delete('/api/uploads/:id', authRequired, async (req, res)=>{
  // Remove the batch's entries and the batch record
  await query('DELETE FROM entries WHERE upload_id=$1', [req.params.id]);
  await query('DELETE FROM uploads WHERE id=$1', [req.params.id]);
  await logAudit(req.user, 'UploadUndone', req.params.id);
  res.json({ ok:true });
});

// ─── AUDIT LOG ───
app.get('/api/audit', authRequired, async (req, res)=>{
  const r = await query('SELECT * FROM audit_log ORDER BY ts DESC LIMIT 1000');
  res.json(r.rows.map(row=>({ ts:row.ts, user:row.user_name, role:row.role, action:row.action, detail:row.detail })));
});

// ─── PUBLIC REGISTRATION (no auth — for member self-registration) ───
const regLimiter = rateLimit({ windowMs: 60*60*1000, max: 50 });
app.post('/api/register', regLimiter, async (req, res)=>{
  try{
    const m = req.body || {};
    if(!m.fullName || !m.conferenceCode || !m.accommodationOption || !m.paymentRef){
      return res.status(400).json({ error:'Missing required fields' });
    }
    // Prevent duplicate refs
    const dup = await query('SELECT id FROM members WHERE payment_ref=$1', [m.paymentRef]);
    if(dup.rows.length) return res.status(409).json({ error:'A registration with this reference already exists.' });
    await query(
      `INSERT INTO members (id,full_name,conference_code,local_church,email,phone,accommodation_option,
         expected_monthly_total,expected_accom,expected_reg,payment_ref,registration_date,ledger,cohort,district)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [m.id, m.fullName, m.conferenceCode, m.localChurch, m.email, m.phone, m.accommodationOption,
       m.expectedMonthlyTotal, m.expectedAccom, m.expectedReg, m.paymentRef, m.registrationDate, JSON.stringify(m.ledger||{}), m.cohort||'new', m.district||null]
    );
    // Respond to the registrant IMMEDIATELY once the member row is saved. All
    // non-essential writes (station list, audit, email) happen AFTER the response
    // so a slow DB/email operation can never make Render time out with a 502.
    res.json({ ok:true });

    // Deferred, fully-guarded follow-up work
    setImmediate(async ()=>{
      // Persist a newly-added station so others can select it next time
      if(m.district && m.localChurch){
        try{
          await query(
            `INSERT INTO custom_stations (conference_code, district, station) VALUES ($1,$2,$3)
             ON CONFLICT (conference_code, district, station) DO NOTHING`,
            [String(m.conferenceCode).toUpperCase(), String(m.district).trim(), String(m.localChurch).trim()]
          );
        }catch(e){ console.error('station upsert on register failed:', e.message); }
      }
      try{ await logAudit({ name:'Self-Registration', role:'Member' }, 'Register', m.paymentRef); }catch(e){}
    });

    // Send confirmation email AFTER responding (fully detached, fully guarded).
    if(m.email){
      setImmediate(async ()=>{
        try{
          const html = buildRegistrationConfirmationHTML(m);
          const r = await sendEmail({
            to: m.email,
            cc: process.env.GMAIL_USER || 'nedloregistration@gmail.com',
            subject: `NEDLO Biennial 2027 – Registration Confirmation (${m.paymentRef})`,
            html,
          });
          if(r.ok){ try{ await logAudit({ name:'System', role:'' }, 'RegistrationEmail', `Confirmation sent to ${m.fullName} (${m.email}) via ${r.provider}`); }catch(e){} }
          else { console.error('Registration confirmation email failed:', r.error); }
        }catch(err){ console.error('Registration email crashed (ignored):', err && err.message); }
      });
    }
  }catch(e){
    console.error('REGISTER ERROR:', e);
    if(!res.headersSent) res.status(500).json({ error:'Registration failed: '+(e.message||e) });
  }
});

// ─── DIAGNOSTIC: entry statistics (read-only) ───
// Reports counts, totals, and the biggest clusters so we can see where any
// inflation comes from. Grouped by amount+reference and by amount+reference+date.
app.get('/api/debug/entry-stats', async (req, res)=>{
  try{
    const all = await query('SELECT txn_date, credit_amount, reference_raw, description, match_status, fingerprint FROM entries');
    const rows = all.rows;
    const norm = s => (s||'').toUpperCase().replace(/\s+/g,' ').trim();
    const total = rows.reduce((s,e)=>s+Number(e.credit_amount||0),0);
    const matched = rows.filter(e=>e.match_status==='MATCHED');
    const matchedTotal = matched.reduce((s,e)=>s+Number(e.credit_amount||0),0);
    // Group by amount + reference (ignores date) to spot same-payment clusters
    const byAmtRef = {};
    rows.forEach(e=>{
      const k = Number(e.credit_amount||0).toFixed(2)+' | '+norm(e.reference_raw);
      if(!byAmtRef[k]) byAmtRef[k]={ count:0, sum:0, dates:[] };
      byAmtRef[k].count++; byAmtRef[k].sum+=Number(e.credit_amount||0); byAmtRef[k].dates.push((e.txn_date||'').trim());
    });
    const clusters = Object.entries(byAmtRef)
      .filter(([,v])=>v.count>1)
      .map(([k,v])=>({ key:k, count:v.count, sum:parseFloat(v.sum.toFixed(2)), dates:v.dates }))
      .sort((a,b)=>b.sum-a.sum).slice(0,40);
    // How many rows have no fingerprint (can't be guarded)
    const noFp = rows.filter(e=>!e.fingerprint || !String(e.fingerprint).trim()).length;
    res.json({
      totalEntries: rows.length,
      totalCredits: parseFloat(total.toFixed(2)),
      matchedEntries: matched.length,
      matchedCredits: parseFloat(matchedTotal.toFixed(2)),
      entriesWithoutFingerprint: noFp,
      topClustersByAmountAndReference: clusters
    });
  }catch(e){ res.status(500).json({ error:String(e.message||e) }); }
});

// ─── MAINTENANCE: purge duplicate bank entries (same txn imported twice) ───
// A "true duplicate" = identical fingerprint OR identical date+amount+ref+desc.
// Keeps the earliest-created row of each group, deletes the rest. Returns a report.
// Build a canonical fingerprint string the same way the client does.
function canonicalFingerprint(txnDate, creditAmount, referenceRaw, description){
  const norm = s => (s||'').toUpperCase().replace(/\s+/g,' ').trim();
  // Normalise the date to ISO (YYYY-MM-DD), handling DD/MM/YYYY and YYYY-MM-DD.
  let iso = (txnDate||'').trim();
  const d1 = iso.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  const d2 = iso.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if(d1){ iso = `${d1[1]}-${String(+d1[2]).padStart(2,'0')}-${String(+d1[3]).padStart(2,'0')}`; }
  else if(d2){ let dd=+d2[1], mm=+d2[2]; if(mm>12&&dd<=12){const t=dd;dd=mm;mm=t;} iso = `${d2[3]}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`; }
  // Identity token = reference if present, else description (matches client txnFingerprint),
  // so a blank-reference payment de-duplicates against its twin that carries a reference.
  const party = norm(referenceRaw) || norm(description);
  return [ iso, Number(creditAmount||0).toFixed(2), party ].join('||');
}

app.post('/api/entries/dedupe', authRequired, async (req, res)=>{
  try{
    const r = await query('SELECT id, txn_date, credit_amount, reference_raw, description, fingerprint FROM entries ORDER BY id ASC');
    const norm = s => (s||'').toUpperCase().replace(/\s+/g,' ').trim();
    const isoOf = (txnDate)=>{ let iso=(txnDate||'').trim();
      const d1=iso.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/); const d2=iso.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
      if(d1) return `${d1[1]}-${String(+d1[2]).padStart(2,'0')}-${String(+d1[3]).padStart(2,'0')}`;
      if(d2){ let dd=+d2[1],mm=+d2[2]; if(mm>12&&dd<=12){const t=dd;dd=mm;mm=t;} return `${d2[3]}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`; }
      return iso; };
    // Pre-pass: which date+amount combos have at least one row with an identified payer?
    const dateAmtHasParty = new Set();
    for(const e of r.rows){
      const party = norm(e.reference_raw) || norm(e.description);
      if(party) dateAmtHasParty.add(isoOf(e.txn_date)+'||'+Number(e.credit_amount||0).toFixed(2));
    }
    const seen = new Map();     // canonical fingerprint -> kept id
    const toDelete = [];
    const toSetFp = [];         // {id, fp} rows that need their fingerprint backfilled
    for(const e of r.rows){
      const fp = canonicalFingerprint(e.txn_date, e.credit_amount, e.reference_raw, e.description);
      const party = norm(e.reference_raw) || norm(e.description);
      const daKey = isoOf(e.txn_date)+'||'+Number(e.credit_amount||0).toFixed(2);
      if(seen.has(fp)){ toDelete.push(e.id); continue; }
      // Blank-party row (no reference AND no description) whose date+amount is also
      // represented by an identified-payer row → it's the same payment, drop it.
      if(!party && dateAmtHasParty.has(daKey)){ toDelete.push(e.id); continue; }
      seen.set(fp, e.id);
      if(String(e.fingerprint||'') !== fp) toSetFp.push({ id:e.id, fp });
    }
    let removed = 0;
    const client = await pool.connect();
    try{
      await client.query('BEGIN');
      // delete duplicates
      for(let i=0;i<toDelete.length;i+=200){
        const chunk = toDelete.slice(i,i+200);
        const params = chunk.map((_,j)=>'$'+(j+1)).join(',');
        const del = await client.query(`DELETE FROM entries WHERE id IN (${params})`, chunk);
        removed += del.rowCount || 0;
      }
      // Backfill canonical fingerprints on kept rows in BULK (one query per chunk
      // via unnest) — a per-row loop was timing out against the pooler.
      for(let i=0;i<toSetFp.length;i+=500){
        const chunk = toSetFp.slice(i,i+500);
        const ids = chunk.map(x=>x.id);
        const fps = chunk.map(x=>x.fp);
        await client.query(
          `UPDATE entries AS e SET fingerprint = v.fp
           FROM (SELECT UNNEST($1::text[]) AS id, UNNEST($2::text[]) AS fp) AS v
           WHERE e.id = v.id`,
          [ids, fps]
        );
      }
      await client.query('COMMIT');
    }catch(err){ await client.query('ROLLBACK'); throw err; }
    finally{ client.release(); }
    await logAudit(req.user, 'EntriesDedupe', `Removed ${removed} duplicates, backfilled ${toSetFp.length} fingerprints (kept ${seen.size})`);
    res.json({ ok:true, removed, kept: seen.size, fingerprintsBackfilled: toSetFp.length });
  }catch(e){ console.error('dedupe error:', e); res.status(500).json({ error:String(e.message||e) }); }
});

// ─── CUSTOM STATIONS (public: used by registration forms + admin) ───
// GET returns all user-added stations grouped by conference/district so the
// registration dropdowns can merge them with the built-in hierarchy.
app.get('/api/stations', async (req, res)=>{
  try{
    const r = await query('SELECT conference_code, district, station FROM custom_stations ORDER BY conference_code, district, station');
    res.json(r.rows.map(x=>({ conferenceCode:x.conference_code, district:x.district, station:x.station })));
  }catch(e){ res.json([]); }
});
// POST adds a new station (public, rate-limited). Idempotent via UNIQUE constraint.
const stationLimiter = rateLimit({ windowMs: 60*60*1000, max: 100 });
app.post('/api/stations', stationLimiter, async (req, res)=>{
  const { conferenceCode, district, station } = req.body||{};
  if(!conferenceCode || !district || !station){
    return res.status(400).json({ error:'conferenceCode, district and station are required' });
  }
  const conf = String(conferenceCode).trim().toUpperCase();
  const dist = String(district).trim();
  const stn  = String(station).trim();
  if(!dist || !stn) return res.status(400).json({ error:'district and station cannot be blank' });
  try{
    await query(
      `INSERT INTO custom_stations (conference_code, district, station) VALUES ($1,$2,$3)
       ON CONFLICT (conference_code, district, station) DO NOTHING`,
      [conf, dist, stn]
    );
    res.json({ ok:true, conferenceCode:conf, district:dist, station:stn });
  }catch(e){ res.status(500).json({ error:String(e.message||e) }); }
});

// ─── CLOUDINARY: signed upload for statement files / exports ───
app.get('/api/cloudinary/signature', authRequired, (req, res)=>{
  const timestamp = Math.round(Date.now()/1000);
  const folder = 'nedlo-stokvel';
  const signature = cloudinary.utils.api_sign_request({ timestamp, folder }, process.env.CLOUDINARY_API_SECRET);
  res.json({ timestamp, folder, signature, apiKey: process.env.CLOUDINARY_API_KEY, cloudName: process.env.CLOUDINARY_CLOUD_NAME });
});

// ─── Helpers to map DB rows ───
function rowToMember(r){
  return { id:r.id, fullName:r.full_name, conferenceCode:r.conference_code, localChurch:r.local_church,
    email:r.email, phone:r.phone, accommodationOption:r.accommodation_option,
    expectedMonthlyTotal:Number(r.expected_monthly_total), expectedAccom:Number(r.expected_accom),
    expectedReg:Number(r.expected_reg), paymentRef:r.payment_ref, registrationDate:r.registration_date,
    cohort:r.cohort||'legacy', lastStatementSentAt:r.last_statement_sent_at||null, lastStatementChannel:r.last_statement_channel||null, district:r.district||'',
    roomNumber:r.room_number, hotelRoom:r.hotel_room, roomPartner:r.room_partner, ledger:r.ledger||{} };
}
function rowToEntry(r){
  return { id:r.id, txnDate:r.txn_date, valDate:r.val_date, description:r.description,
    referenceRaw:r.reference_raw, referenceNorm:r.reference_norm, creditAmount:Number(r.credit_amount),
    contribMonth:r.contrib_month, matchStatus:r.match_status, linkedMemberId:r.linked_member_id,
    allocatedAccom:Number(r.allocated_accom), allocatedReg:Number(r.allocated_reg),
    resolvedBy:r.resolved_by, resolvedAt:r.resolved_at, fingerprint:r.fingerprint, uploadId:r.upload_id };
}
function rowToUpload(r){
  return { id:r.id, filename:r.filename, uploadedAt:r.uploaded_at, uploadedBy:r.uploaded_by,
    rowCount:r.row_count, imported:r.imported, duplicatesSkipped:r.duplicates_skipped,
    creditsAdded:Number(r.credits_added), fromDate:r.from_date, toDate:r.to_date,
    statementTotalEntered:Number(r.statement_total_entered) };
}

// ─── EMAIL: send a single member's statement ───
app.post('/api/send-statement', authRequired, async (req, res)=>{
  const { memberId, settings } = req.body;
  try{
    const mr = await query('SELECT * FROM members WHERE id=$1', [memberId]);
    if(!mr.rows.length) return res.status(404).json({ error:'Member not found' });
    const m = rowToMember(mr.rows[0]);
    if(!m.email) return res.status(400).json({ error:'Member has no email address' });
    const er = await query('SELECT * FROM entries WHERE linked_member_id=$1', [memberId]);
    const entries = er.rows.map(rowToEntry);
    const html = buildStatementHTML(m, entries, settings||{});
    const r = await sendEmail({
      to: m.email,
      subject: `NEDLO Biennial 2027 Stokvel Fund – Contribution Statement for ${m.fullName}`,
      html,
    });
    if(!r.ok) return res.status(500).json({ error:`Email failed (${r.provider}): ${r.error}` });
    await query("UPDATE members SET last_statement_sent_at=now(), last_statement_channel='email' WHERE id=$1", [memberId]);
    await logAudit(req.user, 'EmailSent', `Statement emailed to ${m.fullName} (${m.email}) via ${r.provider}`);
    res.json({ ok:true });
  }catch(e){ console.error('send-statement error:', e.message); res.status(500).json({ error:e.message }); }
});

// ─── EMAIL: bulk send to many members ───
app.post('/api/send-bulk', authRequired, async (req, res)=>{
  const { memberIds, settings } = req.body;
  if(!Array.isArray(memberIds) || !memberIds.length) return res.status(400).json({ error:'No members selected' });
  let sent=0, skipped=0, failed=[], sentIds=[];
  for(const id of memberIds){
    try{
      const mr = await query('SELECT * FROM members WHERE id=$1', [id]);
      if(!mr.rows.length){ skipped++; continue; }
      const m = rowToMember(mr.rows[0]);
      if(!m.email){ skipped++; continue; }
      const er = await query('SELECT * FROM entries WHERE linked_member_id=$1', [id]);
      const entries = er.rows.map(rowToEntry);
      const html = buildStatementHTML(m, entries, settings||{});
      const r = await sendEmail({
        to: m.email,
        subject: `NEDLO Biennial 2027 Stokvel Fund – Contribution Statement for ${m.fullName}`,
        html,
      });
      if(r.ok){ sent++; sentIds.push(id); await query("UPDATE members SET last_statement_sent_at=now(), last_statement_channel='email' WHERE id=$1", [id]); } else { failed.push(id); console.error('bulk send fail', id, r.error); }
      await new Promise(res=>setTimeout(res, 300)); // gentle pacing
    }catch(e){ failed.push(id); console.error('bulk send fail', id, e.message); }
  }
  await logAudit(req.user, 'BulkEmail', `Bulk emailed ${sent} statements (${skipped} skipped, ${failed.length} failed)`);
  res.json({ ok:true, sent, skipped, failed:failed.length, sentIds });
});

// ─── EMAIL: send a general announcement to all (or selected) members ───
// Wraps the provided subject/body (HTML) in the NEDLO letterhead and emails it.
app.post('/api/send-announcement', authRequired, async (req, res)=>{
  const { subject, bodyHtml, memberIds } = req.body || {};
  if(!subject || !bodyHtml) return res.status(400).json({ error:'subject and bodyHtml are required' });
  // Resolve recipient list
  let recipients = [];
  try{
    if(Array.isArray(memberIds) && memberIds.length){
      const params = memberIds.map((_,i)=>'$'+(i+1)).join(',');
      const r = await query(`SELECT full_name, email FROM members WHERE id IN (${params})`, memberIds);
      recipients = r.rows;
    } else {
      const r = await query('SELECT full_name, email FROM members');
      recipients = r.rows;
    }
  }catch(e){ return res.status(500).json({ error:'Could not load members: '+e.message }); }

  const withEmail = recipients.filter(m=>m.email && String(m.email).includes('@'));
  if(!withEmail.length) return res.status(400).json({ error:'No members with a valid email address.' });

  // Letterhead wrapper (ASCII/entities only, UTF-8 safe)
  const wrap = (name, inner) => `<!DOCTYPE html><html><head><meta charset="utf-8"/></head>
    <body style="margin:0;padding:0;background:#f0f4f8;">
    <div style="font-family:'Segoe UI',Arial,sans-serif;font-size:13px;color:#1f2937;max-width:700px;margin:0 auto;padding:16px;">
      <div style="border-bottom:3px solid #1a3a6b;padding-bottom:12px;margin-bottom:14px;">
        <span style="font-size:16px;font-weight:700;color:#1a3a6b;">NEDLO Biennial 2027 Stokvel Fund</span><br/>
        <span style="font-size:11px;color:#6b7280;">19th Episcopal District Lay Organisation</span>
      </div>
      <p>Dear ${name||'Member'},</p>
      ${inner}
      <div style="border-top:1px solid #e5e7eb;padding-top:12px;margin-top:16px;font-size:12px;">
        <p>Yours in service,<br/><strong>NEDLO Financial Secretary's Office</strong><br/>
        <a href="mailto:${process.env.GMAIL_USER||'nedloregistration@gmail.com'}">${process.env.GMAIL_USER||'nedloregistration@gmail.com'}</a></p>
      </div>
    </div></body></html>`;

  let sent=0, failed=0;
  for(const m of withEmail){
    const first = (m.full_name||'').trim().split(' ')[0] || 'Member';
    const r = await sendEmail({ to: m.email, subject, html: wrap(first, bodyHtml) });
    if(r.ok) sent++; else { failed++; console.error('announcement send fail', m.email, r.error); }
    await new Promise(x=>setTimeout(x, 250)); // gentle pacing
  }
  await logAudit(req.user, 'Announcement', `Sent announcement "${subject}" to ${sent} members (${failed} failed)`);
  res.json({ ok:true, sent, failed, totalWithEmail: withEmail.length });
});

app.get('/api/health', async (req,res)=>{
  try{ await query('SELECT 1'); res.json({ ok:true, db:'connected', testMode:TEST_MODE, time:new Date().toISOString() }); }
  catch(e){ res.status(500).json({ ok:false, db:'error', error:String(e.message||e), code:e.code||'', hasDbUrl: !!process.env.DATABASE_URL }); }
});

// Diagnostic: which env var NAMES does the running process see? (names only, no
// secret values). Lets us confirm Render actually passed DATABASE_URL in.
app.get('/api/debug/env-check', (req,res)=>{
  const names = Object.keys(process.env).sort();
  const dbLike = names.filter(n=>/DATAB|PG|POSTGR|URL/i.test(n));
  res.json({
    hasDatabaseUrl: !!process.env.DATABASE_URL,
    databaseUrlLength: (process.env.DATABASE_URL||'').length,
    dbRelatedVarNames: dbLike,          // e.g. shows if it's spelled DATABSE_URL
    appVarNames: names.filter(n=>/TEST_MODE|BREVO|GMAIL|JWT|CLOUDINARY|PASSWORD/i.test(n)),
  });
});

app.listen(PORT, async ()=>{
  console.log(`NEDLO server running on port ${PORT}`);
  await autoInitDb();
});

// ─── Keep-alive: ping the DB every 5 days to prevent Supabase auto-pause ───
setInterval(async ()=>{
  try{ await query('SELECT 1'); console.log('DB keep-alive ping OK'); }
  catch(e){ console.error('Keep-alive ping failed:', e.message); }
}, 5 * 24 * 60 * 60 * 1000); // every 5 days
