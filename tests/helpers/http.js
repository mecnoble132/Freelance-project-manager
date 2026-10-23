// Calls a Vercel function handler with a fake request and collects the response.
const { EventEmitter } = require('events');

async function request(handler, { method = 'GET', url = '/', headers = {}, body, query } = {}) {
  const u = new URL(url, 'https://ledger.test');
  const req = { method, url: u.pathname + u.search, headers: { host: 'ledger.test', ...headers }, body, query: query || Object.fromEntries(u.searchParams) };
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.getHeader = k => res.headers[k.toLowerCase()];
  const ended = new Promise(resolve => { res.end = (data = '') => { res.body = String(data); res.emit('finish'); resolve(); }; });
  await handler(req, res);
  await ended;
  let json; try { json = JSON.parse(res.body); } catch (e) {}
  return { status: res.statusCode, headers: res.headers, body: res.body, json };
}

// The server logs a line per request; keep test output readable.
function quiet(t) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
}

module.exports = { request, quiet };
