// Connecting an app the way Claude does: discovery, registration, the sign-in page, the code-for-token swap with
// PKCE, refreshing, and then calling the MCP endpoint with the token.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { setup } = require('./helpers/setup');
const { request, quiet } = require('./helpers/http');
const { OWNER } = require('./helpers/seed');

const metadata = require('../api/oauth/metadata');
const register = require('../api/oauth/register');
const authorize = require('../api/oauth/authorize');
const token = require('../api/oauth/token');
const mcp = require('../api/mcp');

const USERS = [{ id: OWNER, email: 'me@example.com', password: 'right password' }];
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const verifier = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const form = o => new URLSearchParams(o).toString();

function ctx(t) { quiet(t); return setup(t, { users: USERS }); }

async function registerClient(extra = {}) {
  const r = await request(register, { method: 'POST', body: { redirect_uris: [REDIRECT], client_name: 'Claude', ...extra } });
  assert.equal(r.status, 201, r.body);
  return r.json;
}
const authQuery = (clientId, extra = {}) => ({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, state: 'xyz', code_challenge: challenge, code_challenge_method: 'S256', resource: 'https://ledger.test/api/mcp', ...extra });

async function signIn(clientId, { password = 'right password', action = 'allow', query = {} } = {}) {
  return request(authorize, { method: 'POST', body: { ...authQuery(clientId, query), email: 'me@example.com', password, action } });
}
const codeFrom = r => new URL(r.headers.location).searchParams.get('code');

async function connect() {
  const client = await registerClient();
  const code = codeFrom(await signIn(client.client_id));
  const r = await request(token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT }) });
  assert.equal(r.status, 200, r.body);
  return { client, tokens: r.json };
}
const rpc = (accessToken, body, headers = {}) => request(mcp, { method: 'POST', url: '/api/mcp', headers: { authorization: 'Bearer ' + accessToken, ...headers }, body });

test('discovery documents point at this site', async t => {
  ctx(t);
  const resource = await request(metadata, { query: { type: 'resource' } });
  assert.deepEqual([resource.json.resource, resource.json.authorization_servers], ['https://ledger.test/api/mcp', ['https://ledger.test']]);
  const as = await request(metadata, { query: { type: 'as' } });
  assert.equal(as.json.authorization_endpoint, 'https://ledger.test/api/oauth/authorize');
  assert.deepEqual(as.json.code_challenge_methods_supported, ['S256']);
});

test('the MCP endpoint asks for sign-in and says where', async t => {
  ctx(t);
  const r = await request(mcp, { method: 'POST', url: '/api/mcp', body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } });
  assert.equal(r.status, 401);
  assert.match(r.headers['www-authenticate'], /resource_metadata="https:\/\/ledger\.test\/\.well-known\/oauth-protected-resource\/api\/mcp"/);
  const bad = await rpc('not-a-token', { jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal(bad.status, 401);
  assert.match(bad.headers['www-authenticate'], /invalid_token/);
});

test('registration only accepts safe return addresses', async t => {
  ctx(t);
  for (const uris of [[], ['http://evil.example/cb'], ['https://claude.ai/cb#frag'], ['javascript:alert(1)']]) {
    const r = await request(register, { method: 'POST', body: { redirect_uris: uris } });
    assert.equal(r.status, 400, JSON.stringify(uris));
  }
  const local = await registerClient({ redirect_uris: ['http://localhost:3334/callback'] });
  assert.ok(local.client_id);
  assert.equal(local.client_secret, undefined);
  const confidential = await registerClient({ token_endpoint_auth_method: 'client_secret_post' });
  assert.ok(confidential.client_secret);
});

test('the sign-in page names the app and refuses tampered requests', async t => {
  ctx(t);
  const client = await registerClient();
  const page = await request(authorize, { query: authQuery(client.client_id) });
  assert.equal(page.status, 200);
  assert.match(page.body, /Connect Claude/);
  assert.match(page.body, /claude\.ai/);
  // Allow must be the first submit button, so pressing Enter signs in instead of cancelling.
  assert.ok(page.body.indexOf('value="allow"') < page.body.indexOf('value="deny"'));
  assert.equal(page.headers['x-frame-options'], 'DENY');
  const unknown = await request(authorize, { query: authQuery('forged.client') });
  assert.equal(unknown.status, 400);
  const otherReturn = await request(authorize, { query: authQuery(client.client_id, { redirect_uri: 'https://evil.example/cb' }) });
  assert.equal(otherReturn.status, 400);
  const noPkce = await request(authorize, { query: authQuery(client.client_id, { code_challenge: '' }) });
  assert.equal(noPkce.status, 302);
  assert.equal(new URL(noPkce.headers.location).searchParams.get('error'), 'invalid_request');
});

test('signing in: wrong password, cancel, then allow', async t => {
  ctx(t);
  const client = await registerClient();
  const wrong = await signIn(client.client_id, { password: 'nope' });
  assert.equal(wrong.status, 401);
  assert.match(wrong.body, /Wrong email or password/);
  assert.match(wrong.body, /value="me@example.com"/);
  const deny = await signIn(client.client_id, { action: 'deny', password: '' });
  const d = new URL(deny.headers.location);
  assert.deepEqual([d.origin + d.pathname, d.searchParams.get('error'), d.searchParams.get('state')], [REDIRECT, 'access_denied', 'xyz']);
  const ok = await signIn(client.client_id);
  const u = new URL(ok.headers.location);
  assert.equal(ok.status, 302);
  assert.deepEqual([u.searchParams.get('state'), u.searchParams.get('iss'), u.searchParams.has('error')], ['xyz', 'https://ledger.test', false]);
  assert.ok(u.searchParams.get('code'));
});

test('a code only works with the right verifier, client and return address, and within 2 minutes', async t => {
  ctx(t);
  const client = await registerClient();
  const code = codeFrom(await signIn(client.client_id));
  const swap = body => request(token, { method: 'POST', body: { grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: REDIRECT, ...body } });
  assert.equal((await swap({ code_verifier: 'wrong' })).json.error, 'invalid_grant');
  assert.equal((await swap({ code_verifier: verifier, client_id: (await registerClient({ client_name: 'Another app' })).client_id })).json.error, 'invalid_grant');
  assert.equal((await swap({ code_verifier: verifier, redirect_uri: 'https://claude.ai/other' })).json.error, 'invalid_grant');
  t.mock.timers.setTime(Date.now() + 121e3);
  assert.equal((await swap({ code_verifier: verifier })).json.error, 'invalid_grant');
});

test('confidential clients must send their secret', async t => {
  ctx(t);
  const client = await registerClient({ token_endpoint_auth_method: 'client_secret_basic' });
  const code = codeFrom(await signIn(client.client_id));
  const body = { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT };
  const none = await request(token, { method: 'POST', body: { ...body, client_id: client.client_id } });
  assert.equal(none.status, 401);
  const basic = 'Basic ' + Buffer.from(encodeURIComponent(client.client_id) + ':' + encodeURIComponent(client.client_secret)).toString('base64');
  const ok = await request(token, { method: 'POST', headers: { authorization: basic }, body });
  assert.equal(ok.status, 200, ok.body);
});

test('a connected app can use the tools, and only sees its own user\'s data', async t => {
  ctx(t);
  const { tokens } = await connect();
  assert.deepEqual([tokens.token_type, tokens.expires_in, tokens.scope], ['Bearer', 3600, 'ledger']);
  const init = await rpc(tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.status, 200);
  assert.equal(init.json.result.protocolVersion, '2025-06-18');
  assert.equal(init.json.result.serverInfo.name, 'client-ledger');
  assert.ok(init.json.result.instructions);
  const list = await rpc(tokens.access_token, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.ok(list.json.result.tools.some(x => x.name === 'get_summary'));
  assert.ok(list.json.result.tools.every(x => !('run' in x)));
  const sum = await rpc(tokens.access_token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_summary', arguments: {} } });
  assert.equal(sum.json.result.structuredContent.revenue, 40000); // the other user's ₹77,777 isn't in it
  assert.equal(sum.json.result.isError, false);
});

test('MCP protocol details', async t => {
  ctx(t);
  const { tokens } = await connect();
  const a = tokens.access_token;
  const batch = await rpc(a, [{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'nope' }]);
  assert.deepEqual(batch.json.map(x => x.id), [1, 2]);
  assert.equal(batch.json[1].error.code, -32601);
  const note = await rpc(a, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(note.status, 202);
  const unknownTool = await rpc(a, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'drop_everything' } });
  assert.equal(unknownTool.json.error.code, -32602);
  const badInput = await rpc(a, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'add_payment', arguments: { amount: -1, client: 'GeekBoz' } } });
  assert.equal(badInput.json.result.isError, true);
  assert.match(badInput.json.result.structuredContent.error, /above 0/);
  const parse = await rpc(a, 'not json{');
  assert.equal(parse.status, 400);
  const get = await request(mcp, { method: 'GET', url: '/api/mcp', headers: { authorization: 'Bearer ' + a } });
  assert.equal(get.status, 405);
  const oldVersion = await rpc(a, { jsonrpc: '2.0', id: 6, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(oldVersion.json.result.protocolVersion, '2025-06-18');
  assert.deepEqual(oldVersion.json.result.capabilities, { tools: { listChanged: false }, prompts: { listChanged: false } });
  const prompts = await rpc(a, { jsonrpc: '2.0', id: 7, method: 'prompts/list' });
  assert.deepEqual(prompts.json.result.prompts.map(p => p.name), ['who_owes_me', 'weekly_review']);
  assert.ok(prompts.json.result.prompts.every(p => p.title && p.description && !('text' in p)));
  const got = await rpc(a, { jsonrpc: '2.0', id: 8, method: 'prompts/get', params: { name: 'who_owes_me' } });
  assert.equal(got.json.result.messages[0].role, 'user');
  assert.match(got.json.result.messages[0].content.text, /list_overdue/);
  const nope = await rpc(a, { jsonrpc: '2.0', id: 9, method: 'prompts/get', params: { name: 'nope' } });
  assert.equal(nope.json.error.code, -32602);
});

test('tokens expire, refresh, and stop when the account is gone', async t => {
  const c = ctx(t);
  const { client, tokens } = await connect();
  t.mock.timers.setTime(Date.now() + 3601e3);
  assert.equal((await rpc(tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401);
  const refresh = () => request(token, { method: 'POST', body: { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id } });
  const r = await refresh();
  assert.equal(r.status, 200, r.body);
  assert.equal((await rpc(r.json.access_token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 200);
  assert.equal((await request(token, { method: 'POST', body: { grant_type: 'refresh_token', refresh_token: r.json.access_token, client_id: client.client_id } })).json.error, 'invalid_grant');
  USERS[0].banned_until = new Date(Date.now() + 864e5).toISOString();
  t.after(() => { delete USERS[0].banned_until; });
  assert.equal((await refresh()).json.error, 'invalid_grant');
  assert.ok(c.requests.some(x => x.path === '/auth/v1/admin/users/' + OWNER));
});

test('a token for one site doesn\'t work on another', async t => {
  ctx(t);
  const { tokens } = await connect();
  const r = await rpc(tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'ping' }, { host: 'other-site.test' });
  assert.equal(r.status, 401);
});
