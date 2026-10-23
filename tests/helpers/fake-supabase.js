// Stands in for Supabase's REST and auth APIs by replacing fetch, so the server code under test runs unchanged,
// including api/_lib/supabase.js. Any data request without a user_id filter fails: the service key bypasses
// row-level security, so an unscoped request would be a leak between accounts.
const { Store } = require('./store');
const { parse } = require('./schema');

const URL_BASE = 'https://fake.supabase.test';
const SERVICE_KEY = 'service-role-key-for-tests';
const OAUTH_SECRET = 'a-test-oauth-secret-that-is-long-enough-1234567890';

function env() {
  process.env.SUPABASE_URL = URL_BASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
  process.env.OAUTH_SECRET = OAUTH_SECRET;
}

function respond(status, body) {
  const text = body === undefined ? '' : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
}

// PostgREST filters as the app writes them: col=eq.value and col=is.null.
function matcher(params) {
  const tests = [];
  for (const [k, v] of params) {
    if (k === 'select') continue;
    if (v === 'is.null') tests.push(r => r[k] === null);
    else if (v.startsWith('eq.')) { const want = v.slice(3); tests.push(r => r[k] != null && String(r[k]) === want); }
    else throw new Error('fake-supabase doesn\'t support the filter ' + k + '=' + v);
  }
  return r => tests.every(t => t(r));
}

function install({ store = new Store(parse()), users = [] } = {}) {
  env();
  const requests = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    if (u.origin !== URL_BASE) throw new Error('Unexpected network request in a test: ' + url);
    const method = (opts.method || 'GET').toUpperCase();
    const headers = opts.headers || {};
    requests.push({ method, path: u.pathname, search: u.search });
    if (headers.apikey !== SERVICE_KEY) return respond(401, { message: 'Invalid API key' });

    if (u.pathname === '/auth/v1/token' && u.searchParams.get('grant_type') === 'password') {
      const b = JSON.parse(opts.body);
      const user = users.find(x => x.email === b.email && x.password === b.password);
      return user ? respond(200, { access_token: 'supabase-session', user: { id: user.id, email: user.email } })
        : respond(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
    }
    const admin = /^\/auth\/v1\/admin\/users\/([^/]+)$/.exec(u.pathname);
    if (admin) {
      const user = users.find(x => x.id === admin[1]);
      return user ? respond(200, { id: user.id, email: user.email, banned_until: user.banned_until || null }) : respond(404, { message: 'User not found' });
    }

    const rest = /^\/rest\/v1\/([a-z_]+)$/.exec(u.pathname);
    if (!rest) throw new Error('fake-supabase doesn\'t handle ' + method + ' ' + u.pathname);
    const table = rest[1];
    try {
      if (method === 'POST') {
        const rows = JSON.parse(opts.body);
        if (!Array.isArray(rows) || rows.some(r => !r.user_id)) return respond(500, { message: 'TEST FAILURE: insert without user_id on ' + table });
        const out = rows.map(r => store.insert(table, r, r.user_id));
        return respond(201, /return=representation/.test(headers.Prefer || '') ? out : undefined);
      }
      if (!u.searchParams.get('user_id')) return respond(500, { message: 'TEST FAILURE: ' + method + ' on ' + table + ' without a user_id filter' });
      const match = matcher(u.searchParams);
      if (method === 'GET') return respond(200, store.select(table, match));
      if (method === 'PATCH') {
        const patch = JSON.parse(opts.body);
        if ('user_id' in patch) return respond(500, { message: 'TEST FAILURE: changing user_id on ' + table });
        return respond(200, store.update(table, match, patch));
      }
      if (method === 'DELETE') return respond(200, store.delete(table, match));
    } catch (e) {
      return respond(e.code === 'PGRST205' ? 404 : 400, { code: e.code, message: e.message });
    }
    throw new Error('fake-supabase doesn\'t handle ' + method);
  };
  return { store, requests, restore: () => { globalThis.fetch = original; } };
}

module.exports = { install, env, URL_BASE, SERVICE_KEY, OAUTH_SECRET };
