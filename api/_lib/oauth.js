// OAuth 2.1 for the MCP server, without a database: client registrations, authorization codes and tokens
// are all signed with OAUTH_SECRET (HMAC-SHA256). Changing OAUTH_SECRET signs every connected app out.
const crypto = require('crypto');

const ACCESS_TTL = 3600;           // 1 hour
const REFRESH_TTL = 30 * 86400;    // 30 days
const CODE_TTL = 120;              // 2 minutes
const SCOPE = 'ledger';

function secret() {
  const s = process.env.OAUTH_SECRET;
  if (!s || s.length < 32) throw new Error('OAUTH_SECRET is missing or shorter than 32 characters in the Vercel environment variables.');
  return s;
}
const now = () => Math.floor(Date.now() / 1000);
const b64 = s => Buffer.from(s).toString('base64url');
const mac = (data, purpose) => crypto.createHmac('sha256', secret()).update(purpose + '.' + data).digest('base64url');

// The token type is part of the signature, so a code can never be used as a token, or a refresh token as an access token.
function sign(type, payload, ttl) {
  const body = b64(JSON.stringify({ ...payload, iat: now(), exp: ttl ? now() + ttl : undefined }));
  return body + '.' + mac(body, type);
}
function verify(type, token) {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const want = Buffer.from(mac(body, type)), got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (p.exp && p.exp < now()) return null;
    return p;
  } catch (e) { return null; }
}
const clientSecret = clientId => mac(clientId, 'client-secret');
const safeEqual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const pkce = verifier => crypto.createHash('sha256').update(verifier).digest('base64url');

// ---------- http helpers ----------
function baseUrl(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host).split(',')[0].trim();
  return proto + '://' + host;
}
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id');
  res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, Mcp-Session-Id');
}
function json(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  for (const k in headers) res.setHeader(k, headers[k]);
  res.end(JSON.stringify(body));
}
// Vercel parses JSON and form bodies into objects; plain Node gives a string. Handle both.
function body(req) {
  const b = req.body;
  if (b && typeof b === 'object' && !Buffer.isBuffer(b)) return b;
  const s = Buffer.isBuffer(b) ? b.toString() : (b || '');
  if (!s) return {};
  if (/json/.test(req.headers['content-type'] || '')) { try { return JSON.parse(s); } catch (e) { return {}; } }
  return Object.fromEntries(new URLSearchParams(s));
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Redirect URIs must be https, or http on this computer for desktop apps, with no fragment.
function validRedirect(u) {
  try {
    const x = new URL(u);
    if (x.hash) return false;
    if (x.protocol === 'https:') return true;
    return x.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname);
  } catch (e) { return false; }
}

module.exports = { sign, verify, clientSecret, safeEqual, pkce, baseUrl, cors, json, body, esc, validRedirect, ACCESS_TTL, REFRESH_TTL, CODE_TTL, SCOPE };
