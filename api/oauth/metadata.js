// OAuth discovery documents: protected resource metadata (RFC 9728) and authorization server metadata (RFC 8414).
// vercel.json routes the /.well-known/ addresses here.
const { baseUrl, cors, json, SCOPE, logRequest } = require('../_lib/oauth');

module.exports = (req, res) => {
  logRequest(req, res, () => 'type=' + req.query.type);
  cors(res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  const base = baseUrl(req);
  if (req.query.type === 'resource') {
    return json(res, 200, { resource: base + '/api/mcp', authorization_servers: [base], scopes_supported: [SCOPE], bearer_methods_supported: ['header'], resource_name: 'Client Ledger' });
  }
  json(res, 200, {
    issuer: base,
    authorization_endpoint: base + '/api/oauth/authorize',
    token_endpoint: base + '/api/oauth/token',
    registration_endpoint: base + '/api/oauth/register',
    scopes_supported: [SCOPE],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true
  });
};
