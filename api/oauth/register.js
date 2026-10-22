// Dynamic client registration (RFC 7591). Nothing is stored: the client id is a signed copy of the registration,
// so the redirect addresses can't be changed later.
const { sign, clientSecret, cors, json, body, validRedirect } = require('../_lib/oauth');

module.exports = (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return json(res, 405, { error: 'invalid_request', error_description: 'Use POST.' }, { Allow: 'POST' });
  const b = body(req);
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map(String) : [];
  if (!uris.length || uris.length > 10 || !uris.every(validRedirect)) return console.warn('[oauth/register] bad redirect_uris', JSON.stringify(b.redirect_uris)), json(res, 400, { error: 'invalid_redirect_uri', error_description: 'redirect_uris must be https addresses (or http on localhost).' });
  const method = ['client_secret_post', 'client_secret_basic'].includes(b.token_endpoint_auth_method) ? b.token_endpoint_auth_method : 'none';
  const name = String(b.client_name || 'An app').slice(0, 100);
  const clientId = sign('client', { ru: uris, n: name, am: method });
  const out = { client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name, redirect_uris: uris,
    token_endpoint_auth_method: method, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] };
  if (method !== 'none') { out.client_secret = clientSecret(clientId); out.client_secret_expires_at = 0; }
  json(res, 201, out);
};
