// The page an app (like Claude) sends you to when connecting: sign in with your Client Ledger account and allow access.
// On success it redirects back to the app with a short-lived, single-purpose code.
const { sign, verify, esc, body, baseUrl, CODE_TTL, SCOPE } = require('../_lib/oauth');
const { signIn } = require('../_lib/supabase');

function page(res, status, inner) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Connect to Client Ledger</title>
<style>
:root{--bg:#f3f5f8;--panel:#fff;--fg:#141821;--muted:#5d6577;--line:#e1e5ec;--accent:#2b4fd8;--accent-ink:#fff;--out:#c23d2a}
@media (prefers-color-scheme:dark){:root{--bg:#0f1218;--panel:#181c25;--fg:#eef0f5;--muted:#9aa2b4;--line:#2a303d;--accent:#7d95ff;--accent-ink:#0f1218;--out:#ff8a76;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;padding:0 16px}
.card{max-width:400px;margin:8vh auto;background:var(--panel);border-radius:18px;padding:24px;display:flex;flex-direction:column;gap:14px;box-shadow:0 1px 2px rgba(20,24,33,.06),0 8px 24px rgba(20,24,33,.06)}
h1{font-size:22px;margin:0}p{margin:0}.muted{color:var(--muted);font-size:14px}.err{color:var(--out);font-size:14px}
ul{margin:0;padding-left:20px;color:var(--muted);font-size:14px}
label{font-size:13px;font-weight:600;color:var(--muted);display:flex;flex-direction:column;gap:5px}
input{font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:10px 12px;width:100%}
.row{display:flex;gap:8px}button{flex:1;font:inherit;font-weight:600;border-radius:10px;padding:10px 14px;border:1px solid var(--line);background:var(--panel);color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
code{font-size:13px;overflow-wrap:anywhere}
</style><div class="card">${inner}</div></html>`);
}
const errorPage = (res, msg) => page(res, 400, `<h1>Can’t connect</h1><p class="err">${esc(msg)}</p><p class="muted">Go back to the app and try connecting again.</p>`);

// Checks the request against the signed client registration. Returns { params, client } or { error }.
function check(q) {
  const client = verify('client', q.client_id);
  if (!client) return { error: 'This app isn’t registered with Client Ledger.' };
  if (!q.redirect_uri || !client.ru.includes(q.redirect_uri)) return { error: 'The app’s return address doesn’t match its registration.' };
  const params = { client_id: q.client_id, redirect_uri: q.redirect_uri, state: q.state || '', code_challenge: q.code_challenge || '',
    code_challenge_method: q.code_challenge_method || '', scope: q.scope || SCOPE, resource: q.resource || '' };
  if (params.resource && !/^https?:\/\/[^/]+(\/api\/mcp)?\/?$/.test(params.resource)) return { client, params, redirectError: 'invalid_target', description: 'Unknown resource.' };
  if (q.response_type !== 'code') return { client, params, redirectError: 'unsupported_response_type' };
  if (!params.code_challenge || params.code_challenge_method !== 'S256') return { client, params, redirectError: 'invalid_request', description: 'PKCE with S256 is required.' };
  return { client, params };
}

function redirect(res, base, uri, query) {
  const u = new URL(uri);
  for (const k in query) if (query[k] != null && query[k] !== '') u.searchParams.set(k, query[k]);
  u.searchParams.set('iss', base);
  res.statusCode = 302; res.setHeader('Location', u.href); res.setHeader('Cache-Control', 'no-store'); res.end();
}

function form(res, c, email, error) {
  const hidden = Object.entries(c.params).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  const host = new URL(c.params.redirect_uri).host;
  page(res, error ? 401 : 200, `<h1>Connect ${esc(c.client.n)}</h1>
<p class="muted"><b>${esc(c.client.n)}</b> wants access to your Client Ledger. It will be able to:</p>
<ul><li>see your clients, projects and money</li><li>add, change and delete them (every change can be undone)</li></ul>
<p class="muted">After you sign in you’ll be sent back to <code>${esc(host)}</code>. Only continue if that’s the app you’re connecting.</p>
<form method="post" style="display:flex;flex-direction:column;gap:14px">${hidden}
<label>Email<input name="email" type="email" autocomplete="email" required value="${esc(email)}"></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required></label>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}
<div class="row"><button type="submit" name="action" value="deny" formnovalidate>Cancel</button><button class="primary" type="submit" name="action" value="allow">Sign in and allow</button></div>
</form>`);
}

module.exports = async (req, res) => {
  const base = baseUrl(req);
  if (req.method !== 'GET' && req.method !== 'POST') { res.statusCode = 405; res.setHeader('Allow', 'GET, POST'); return res.end(); }
  const input = req.method === 'POST' ? body(req) : req.query;
  const c = check(input);
  if (c.error) return errorPage(res, c.error);
  if (c.redirectError) return redirect(res, base, c.params.redirect_uri, { error: c.redirectError, error_description: c.description, state: c.params.state });
  if (req.method === 'GET') return form(res, c, '', '');

  if (input.action === 'deny') return redirect(res, base, c.params.redirect_uri, { error: 'access_denied', state: c.params.state });
  const email = String(input.email || '').trim().slice(0, 320), password = String(input.password || '');
  const user = email && password ? await signIn(email, password) : null;
  if (!user) { await new Promise(r => setTimeout(r, 800)); return form(res, c, email, 'Wrong email or password.'); }
  const code = sign('code', { cid: c.params.client_id, ru: c.params.redirect_uri, cc: c.params.code_challenge, uid: user.id, em: user.email, sc: SCOPE, aud: base + '/api/mcp' }, CODE_TTL);
  redirect(res, base, c.params.redirect_uri, { code, state: c.params.state });
};
