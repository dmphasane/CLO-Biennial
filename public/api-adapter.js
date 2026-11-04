// ═══════════════════════════════════════════════════════════
// API ADAPTER — replaces localStorage with backend API calls
// Include this BEFORE the main app script in index.html.
// It overrides saveDB/loadDB and login to talk to the server.
// ═══════════════════════════════════════════════════════════

// Point this at your Render API. Empty string = same origin (recommended when
// the frontend is served from the same Render service as the API).
const API_BASE = '';

let AUTH_TOKEN = sessionStorage.getItem('nedlo_token') || null;

async function apiFetch(path, options={}){
  const headers = { 'Content-Type':'application/json', ...(options.headers||{}) };
  if(AUTH_TOKEN) headers['Authorization'] = 'Bearer ' + AUTH_TOKEN;
  // Optional per-call timeout (ms). Used by bulk saves so a request the server never
  // answers fails with a clear error instead of blocking every save queued behind it.
  const { timeoutMs, ...fetchOpts } = options;
  let timer = null, signal;
  if(timeoutMs){
    const ctrl = new AbortController();
    signal = ctrl.signal;
    timer = setTimeout(()=>ctrl.abort(), timeoutMs);
  }
  let res;
  try{
    res = await fetch(API_BASE + path, { ...fetchOpts, headers, signal });
  }catch(e){
    if(e && e.name === 'AbortError') throw new Error('Request timed out');
    throw e;
  }finally{
    if(timer) clearTimeout(timer);
  }
  const isLogin = path.indexOf('/api/login') !== -1;
  if(res.status === 401 && !isLogin){
    // Token expired on a normal request — force re-login
    AUTH_TOKEN = null;
    sessionStorage.removeItem('nedlo_token');
    if(typeof doLogout === 'function') doLogout();
    throw new Error('Session expired. Please log in again.');
  }
  if(!res.ok){
    const err = await res.json().catch(()=>({error:'Request failed'}));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

// ─── Override login to use the API ───
async function apiLogin(username, password){
  // Clear any stale token before logging in
  AUTH_TOKEN = null;
  sessionStorage.removeItem('nedlo_token');
  const data = await apiFetch('/api/login', {
    method:'POST',
    body: JSON.stringify({ username, password })
  });
  AUTH_TOKEN = data.token;
  sessionStorage.setItem('nedlo_token', AUTH_TOKEN);
  return data.user;
}

// ─── Load all data from the API into the DB object ───
// Resilient: members + entries are REQUIRED (retried); aliases/audit/uploads are
// optional and default to empty if their endpoint is slow or errors, so one
// failing sub-request never aborts the whole reload.
async function apiLoadAll(){
  async function getWithRetry(path, tries){
    let lastErr;
    for(let i=0;i<(tries||3);i++){
      try{ return await apiFetch(path); }
      catch(e){ lastErr=e; await new Promise(r=>setTimeout(r, 1500)); }
    }
    throw lastErr;
  }
  // Required data — retry a few times (pooler can be briefly slow)
  const members = await getWithRetry('/api/members', 3);
  const entries = await getWithRetry('/api/entries', 3);
  // Optional data — never fail the whole load if these error
  const aliases = await apiFetch('/api/aliases').catch(()=>({}));
  const audit   = await apiFetch('/api/audit').catch(()=>[]);
  const uploads = await apiFetch('/api/uploads').catch(()=>[]);
  return { members: members||[], entries: entries||[], refAliases: aliases||{}, auditLog: audit||[], uploads: uploads||[] };
}

// ─── Persist helpers ───
async function apiSaveMember(m){ return apiFetch('/api/members', { method:'POST', body: JSON.stringify(m), timeoutMs: 45000 }); }
async function apiDeleteMember(id){ return apiFetch('/api/members/'+id, { method:'DELETE' }); }
async function apiSaveEntries(entries){ return apiFetch('/api/entries/bulk', { method:'POST', body: JSON.stringify({ entries }) }); }
async function apiClearEntries(){ return apiFetch('/api/entries', { method:'DELETE' }); }
async function apiDeleteEntry(id){ return apiFetch('/api/entries/'+id, { method:'DELETE' }); }
async function apiSaveAlias(refNorm, memberId, memberIds){ return apiFetch('/api/aliases', { method:'POST', body: JSON.stringify({ refNorm, memberId, memberIds }) }); }
async function apiRegister(m){ return apiFetch('/api/register', { method:'POST', body: JSON.stringify(m) }); }
async function apiSaveUpload(u){ return apiFetch('/api/uploads', { method:'POST', body: JSON.stringify(u) }); }
async function apiDeleteUpload(id){ return apiFetch('/api/uploads/'+id, { method:'DELETE' }); }

// ─── Debounced full-save: pushes the whole DB state to the server ───
let _saveTimer = null;
// Show / clear a visible warning when records could not be saved to the server.
// Previously a single failed save was only written to the console, which silently
// stopped every record after it from saving (and the changes were lost on reload).
function reportSyncResult(failures){
  let el = document.getElementById('sync-warning');
  if(!failures.length){ if(el) el.remove(); return; }
  if(!el){
    el = document.createElement('div');
    el.id = 'sync-warning';
    el.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:16px;z-index:3000;max-width:720px;width:92vw;background:#fef2f2;color:#991b1b;border:1px solid #fecaca;border-radius:8px;padding:10px 14px;font-size:12.5px;box-shadow:0 4px 16px rgba(0,0,0,.2);';
    document.body.appendChild(el);
  }
  const names = failures.slice(0,6).map(f=>f.name+(f.error?' ('+f.error+')':'')).join('; ');
  el.innerHTML = '<strong>⚠ '+failures.length+' record(s) could not be saved to the server</strong> — changes to these may be lost on reload. '
    + names + (failures.length>6?' …and '+(failures.length-6)+' more':'') 
    + ' <button onclick="this.parentNode.remove()" style="margin-left:8px;cursor:pointer;">Dismiss</button>';
}

async function apiPushAll(DB){
  // Save members one by one. A failure on one record must NOT stop the remaining
  // records from saving, and must be reported rather than swallowed.
  const failures = [];
  const deletedElsewhere = new Set();
  let saved = 0, consecutive = 0;
  for(const m of DB.members){
    try{
      const r = await apiSaveMember(m);
      // The server refuses to re-create a member an administrator has deleted.
      if(r && r.skipped === 'deleted'){ deletedElsewhere.add(m.id); continue; }
      saved++; consecutive = 0;
    }catch(e){
      console.error('Member save failed:', m.paymentRef, e.message);
      if(/Session expired/i.test(e.message)){ failures.push({ name:'(session)', error:e.message }); break; }
      failures.push({ name:m.fullName||m.paymentRef, ref:m.paymentRef, error:e.message });
      // If the server is clearly down, stop instead of timing out on every record.
      if(++consecutive >= 5){ failures.push({ name:'(remaining records)', error:'server not responding — stopped' }); break; }
    }
  }
  try{
    if(DB.entries.length) await apiSaveEntries(DB.entries);
    for(const [refNorm, val] of Object.entries(DB.refAliases||{})){
      if(Array.isArray(val)) await apiSaveAlias(refNorm, null, val);
      else await apiSaveAlias(refNorm, val, null);
    }
    for(const u of (DB.uploads||[])){ await apiSaveUpload(u); }
  }catch(e){
    console.error('Push failed:', e.message);
    failures.push({ name:'(payments/aliases/uploads)', error:e.message });
  }
  // Drop members that were deleted from another session so this browser stops showing them.
  if(deletedElsewhere.size){
    for(let i = DB.members.length - 1; i >= 0; i--){
      if(deletedElsewhere.has(DB.members[i].id)) DB.members.splice(i, 1);
    }
    try{ localStorage.setItem('nedlo_db', JSON.stringify(DB)); }catch(e){}
    if(typeof renderMembersTable === 'function') renderMembersTable();
    if(typeof renderDashboard === 'function') renderDashboard();
  }
  reportSyncResult(failures);
  return { saved, total: DB.members.length, failures };
}
