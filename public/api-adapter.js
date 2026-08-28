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
  if(res.status === 401){
    // Token expired — force re-login
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
  const data = await apiFetch('/api/login', {
    method:'POST',
    body: JSON.stringify({ username, password })
  });
  AUTH_TOKEN = data.token;
  sessionStorage.setItem('nedlo_token', AUTH_TOKEN);
  return data.user;
}

// ─── Load all data from the API into the DB object ───
async function apiLoadAll(){
  const [members, entries, aliases, audit] = await Promise.all([
    apiFetch('/api/members'),
    apiFetch('/api/entries'),
    apiFetch('/api/aliases'),
    apiFetch('/api/audit'),
  ]);
  return { members, entries, refAliases: aliases||{}, auditLog: audit||[] };
}

// ─── Persist helpers ───
async function apiSaveMember(m){ return apiFetch('/api/members', { method:'POST', body: JSON.stringify(m) }); }
async function apiDeleteMember(id){ return apiFetch('/api/members/'+id, { method:'DELETE' }); }
async function apiSaveEntries(entries){ return apiFetch('/api/entries/bulk', { method:'POST', body: JSON.stringify({ entries }) }); }
async function apiClearEntries(){ return apiFetch('/api/entries', { method:'DELETE' }); }
async function apiSaveAlias(refNorm, memberId, memberIds){ return apiFetch('/api/aliases', { method:'POST', body: JSON.stringify({ refNorm, memberId, memberIds }) }); }
async function apiRegister(m){ return apiFetch('/api/register', { method:'POST', body: JSON.stringify(m) }); }

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
  }catch(e){ console.error('Push failed:', e.message); }
}
