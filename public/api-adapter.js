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
  const res = await fetch(API_BASE + path, { ...options, headers });
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
async function apiSaveMember(m){ return apiFetch('/api/members', { method:'POST', body: JSON.stringify(m) }); }
async function apiDeleteMember(id){ return apiFetch('/api/members/'+id, { method:'DELETE' }); }
async function apiSaveEntries(entries){ return apiFetch('/api/entries/bulk', { method:'POST', body: JSON.stringify({ entries }) }); }
async function apiClearEntries(){ return apiFetch('/api/entries', { method:'DELETE' }); }
async function apiSaveAlias(refNorm, memberId, memberIds){ return apiFetch('/api/aliases', { method:'POST', body: JSON.stringify({ refNorm, memberId, memberIds }) }); }
async function apiRegister(m){ return apiFetch('/api/register', { method:'POST', body: JSON.stringify(m) }); }
async function apiSaveUpload(u){ return apiFetch('/api/uploads', { method:'POST', body: JSON.stringify(u) }); }
async function apiDeleteUpload(id){ return apiFetch('/api/uploads/'+id, { method:'DELETE' }); }

// ─── Debounced full-save: pushes the whole DB state to the server ───
let _saveTimer = null;
async function apiPushAll(DB){
  // Save all members and entries in bulk
  try{
    for(const m of DB.members){ await apiSaveMember(m); }
    if(DB.entries.length) await apiSaveEntries(DB.entries);
    for(const [refNorm, val] of Object.entries(DB.refAliases||{})){
      if(Array.isArray(val)) await apiSaveAlias(refNorm, null, val);
      else await apiSaveAlias(refNorm, val, null);
    }
    for(const u of (DB.uploads||[])){ await apiSaveUpload(u); }
  }catch(e){ console.error('Push failed:', e.message); }
}
