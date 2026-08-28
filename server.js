import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { v2 as cloudinary } from 'cloudinary';
import dotenv from 'dotenv';
import { pool, query } from './db.js';

dotenv.config();

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
app.use(express.static('public')); // serves the frontend

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
app.post('/api/login', authLimiter, async (req, res)=>{
  const { username, password } = req.body;
  try{
    const r = await query('SELECT * FROM users WHERE username=$1', [username]);
    if(!r.rows.length) return res.status(401).json({ error:'Invalid credentials' });
    const user = r.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if(!ok) return res.status(401).json({ error:'Invalid credentials' });
    await logAudit(user, 'Login', 'User signed in');
    res.json({ token: signToken(user), user:{ name:user.full_name, role:user.role, username:user.username } });
  }catch(e){ console.error(e); res.status(500).json({ error:'Server error' }); }
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
       expected_monthly_total,expected_accom,expected_reg,payment_ref,registration_date,ledger)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (id) DO UPDATE SET full_name=$2,conference_code=$3,local_church=$4,email=$5,phone=$6,
       accommodation_option=$7,expected_monthly_total=$8,expected_accom=$9,expected_reg=$10,payment_ref=$11,
       ledger=$13,updated_at=now()`,
    [m.id, m.fullName, m.conferenceCode, m.localChurch, m.email, m.phone, m.accommodationOption,
     m.expectedMonthlyTotal, m.expectedAccom, m.expectedReg, m.paymentRef, m.registrationDate, JSON.stringify(m.ledger||{})]
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
      await client.query(
        `INSERT INTO entries (id,txn_date,val_date,description,reference_raw,reference_norm,credit_amount,
           contrib_month,match_status,linked_member_id,allocated_accom,allocated_reg,resolved_by,resolved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (id) DO UPDATE SET match_status=$9,linked_member_id=$10,allocated_accom=$11,
           allocated_reg=$12,resolved_by=$13,resolved_at=$14,contrib_month=$8`,
        [e.id,e.txnDate,e.valDate,e.description,e.referenceRaw,e.referenceNorm,e.creditAmount,
         e.contribMonth,e.matchStatus,e.linkedMemberId,e.allocatedAccom,e.allocatedReg,e.resolvedBy,e.resolvedAt]
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

// ─── AUDIT LOG ───
app.get('/api/audit', authRequired, async (req, res)=>{
  const r = await query('SELECT * FROM audit_log ORDER BY ts DESC LIMIT 1000');
  res.json(r.rows.map(row=>({ ts:row.ts, user:row.user_name, role:row.role, action:row.action, detail:row.detail })));
});

// ─── PUBLIC REGISTRATION (no auth — for member self-registration) ───
const regLimiter = rateLimit({ windowMs: 60*60*1000, max: 50 });
app.post('/api/register', regLimiter, async (req, res)=>{
  const m = req.body;
  if(!m.fullName || !m.conferenceCode || !m.accommodationOption || !m.paymentRef){
    return res.status(400).json({ error:'Missing required fields' });
  }
  // Prevent duplicate refs
  const dup = await query('SELECT id FROM members WHERE payment_ref=$1', [m.paymentRef]);
  if(dup.rows.length) return res.status(409).json({ error:'A registration with this reference already exists.' });
  await query(
    `INSERT INTO members (id,full_name,conference_code,local_church,email,phone,accommodation_option,
       expected_monthly_total,expected_accom,expected_reg,payment_ref,registration_date,ledger)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [m.id, m.fullName, m.conferenceCode, m.localChurch, m.email, m.phone, m.accommodationOption,
     m.expectedMonthlyTotal, m.expectedAccom, m.expectedReg, m.paymentRef, m.registrationDate, JSON.stringify(m.ledger||{})]
  );
  await logAudit({ name:'Self-Registration', role:'Member' }, 'Register', m.paymentRef);
  res.json({ ok:true });
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
    roomNumber:r.room_number, hotelRoom:r.hotel_room, roomPartner:r.room_partner, ledger:r.ledger||{} };
}
function rowToEntry(r){
  return { id:r.id, txnDate:r.txn_date, valDate:r.val_date, description:r.description,
    referenceRaw:r.reference_raw, referenceNorm:r.reference_norm, creditAmount:Number(r.credit_amount),
    contribMonth:r.contrib_month, matchStatus:r.match_status, linkedMemberId:r.linked_member_id,
    allocatedAccom:Number(r.allocated_accom), allocatedReg:Number(r.allocated_reg),
    resolvedBy:r.resolved_by, resolvedAt:r.resolved_at };
}

app.get('/api/health', async (req,res)=>{
  try{ await query('SELECT 1'); res.json({ ok:true, db:'connected', time:new Date().toISOString() }); }
  catch(e){ res.status(500).json({ ok:false, db:'error', error:e.message }); }
});

app.listen(PORT, ()=>console.log(`NEDLO server running on port ${PORT}`));

// ─── Keep-alive: ping the DB every 5 days to prevent Supabase auto-pause ───
setInterval(async ()=>{
  try{ await query('SELECT 1'); console.log('DB keep-alive ping OK'); }
  catch(e){ console.error('Keep-alive ping failed:', e.message); }
}, 5 * 24 * 60 * 60 * 1000); // every 5 days
