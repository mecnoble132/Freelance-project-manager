// Exchanges an authorization code (with its PKCE verifier) or a refresh token for an access token.
const { sign, verify, clientSecret, safeEqual, pkce, baseUrl, cors, json, body, ACCESS_TTL, REFRESH_TTL, SCOPE } = require('../_lib/oauth');
const { userStillActive } = require('../_lib/supabase');

const oops = (res, error, description, status = 400) => { console.warn('[oauth/token]', status, error, '-', description); json(res, status, { error, error_description: description }); };

// Public clients send only client_id; confidential ones also prove they hold the secret issued at registration.
function authClient(req, b) {
  let id = b.client_id, sec = b.client_secret;
  const basic = /^Basic\s+(.+)$/i.exec(req.headers.authorization || '');
  if (basic) { const [u, p] = Buffer.from(basic[1], 'base64').toString().split(':'); id = decodeURIComponent(u || ''); sec = decodeURIComponent(p || ''); }
  const client = verify('client', id);
  if (!client) return null;
  if (client.am !== 'none' && !(sec && safeEqual(sec, clientSecret(id)))) return null;
  return { id, client };
}

function issue(res, base, user, clientId) {
  const claims = { sub: user.id, em: user.email, cid: clientId, sc: SCOPE, aud: base + '/api/mcp' };
  json(res, 200, { access_token: sign('access', claims, ACCESS_TTL), token_type: 'Bearer', expires_in: ACCESS_TTL,
    refresh_token: sign('refresh', claims, REFRESH_TTL), scope: SCOPE });
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return oops(res, 'invalid_request', 'Use POST.', 405);
  const base = baseUrl(req), b = body(req);
  const c = authClient(req, b);
  if (!c) return oops(res, 'invalid_client', 'Unknown client or wrong client secret.', 401);

  if (b.grant_type === 'authorization_code') {
    const code = verify('code', b.code);
    if (!code || code.cid !== c.id) return oops(res, 'invalid_grant', 'The code is invalid or has expired.');
    if (b.redirect_uri && b.redirect_uri !== code.ru) return oops(res, 'invalid_grant', 'redirect_uri doesn’t match.');
    if (!b.code_verifier || !safeEqual(pkce(String(b.code_verifier)), code.cc)) return oops(res, 'invalid_grant', 'PKCE verification failed.');
    // The code was minted moments ago, right after the password was checked, so it already names the user.
    return issue(res, base, { id: code.uid, email: code.em }, c.id);
  }
  if (b.grant_type === 'refresh_token') {
    const r = verify('refresh', b.refresh_token);
    if (!r || r.cid !== c.id) return oops(res, 'invalid_grant', 'The refresh token is invalid or has expired.');
    if (!(await userStillActive(r.sub))) return oops(res, 'invalid_grant', 'That account no longer exists.');
    return issue(res, base, { id: r.sub, email: r.em }, c.id);
  }
  oops(res, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
};
