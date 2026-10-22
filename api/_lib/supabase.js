// Server-side Supabase access with the service_role key. Every query is scoped to one user's rows by hand,
// because the service_role key bypasses row-level security.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('The server is missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in its Vercel environment variables.');
  return { url: url.replace(/\/$/, ''), key };
}

function headers(extra) {
  const { key } = config();
  // New-style secret keys (sb_secret_…) go in the apikey header only; legacy service_role keys are JWTs and also go in Authorization.
  const h = { apikey: key, 'Content-Type': 'application/json', ...extra };
  if (!key.startsWith('sb_')) h.Authorization = 'Bearer ' + key;
  return h;
}

class DbError extends Error {}

async function rest(method, path, body, prefer) {
  const { url } = config();
  const res = await fetch(url + '/rest/v1/' + path, { method, headers: headers(prefer ? { Prefer: prefer } : {}), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { const j = JSON.parse(text); msg = j.message || text; if (j.code === '23514') msg = 'A value was out of range (' + j.message + ')'; } catch (e) {}
    throw new DbError('The database refused the change: ' + String(msg).slice(0, 300));
  }
  return text ? JSON.parse(text) : null;
}

const id = v => { if (!UUID.test(String(v))) throw new DbError('Not a valid id: ' + v); return v; };

// One user's view of the database.
function forUser(uid) {
  id(uid);
  const scope = (filters = {}) => Object.entries(filters).map(([k, v]) => '&' + k + '=' + (v === null ? 'is.null' : 'eq.' + id(v))).join('');
  return {
    uid,
    select: (table, filters) => rest('GET', table + '?select=*&user_id=eq.' + uid + scope(filters)),
    insert: (table, rows) => rest('POST', table, (Array.isArray(rows) ? rows : [rows]).map(r => ({ ...r, user_id: uid })), 'return=representation'),
    update: (table, rowId, patch) => rest('PATCH', table + '?id=eq.' + id(rowId) + '&user_id=eq.' + uid, patch, 'return=representation'),
    updateWhere: (table, filters, patch) => rest('PATCH', table + '?user_id=eq.' + uid + scope(filters), patch, 'return=representation'),
    remove: (table, rowId) => rest('DELETE', table + '?id=eq.' + id(rowId) + '&user_id=eq.' + uid, undefined, 'return=representation')
  };
}

// Checks an email and password against Supabase Auth. Returns { id, email } or null.
async function signIn(email, password) {
  const { url } = config();
  const res = await fetch(url + '/auth/v1/token?grant_type=password', { method: 'POST', headers: headers(), body: JSON.stringify({ email, password }) });
  if (!res.ok) return null;
  const j = await res.json();
  return j && j.user ? { id: j.user.id, email: j.user.email } : null;
}

// Checks an account still exists, so refresh tokens stop working once it's deleted or banned.
// Returns false only when Supabase clearly says so; if the check itself can't run (for example the key
// isn't allowed to use the admin API), it logs why and lets the signed token stand.
async function userStillActive(uid) {
  if (!UUID.test(String(uid))) return false;
  const { url } = config();
  try {
    const res = await fetch(url + '/auth/v1/admin/users/' + uid, { headers: headers() });
    if (res.status === 404) return false;
    if (!res.ok) { console.warn('[auth] account check skipped: admin API returned', res.status, (await res.text()).slice(0, 200)); return true; }
    const u = await res.json();
    return !(u.banned_until && Date.parse(u.banned_until) > Date.now());
  } catch (e) { console.warn('[auth] account check skipped:', e.message); return true; }
}

module.exports = { forUser, signIn, userStillActive, DbError, UUID };
