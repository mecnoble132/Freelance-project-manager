// MCP server (Streamable HTTP, stateless) so an AI assistant can read and change the ledger.
// Every request needs an OAuth access token from /api/oauth; the token says whose data to use.
const { verify, baseUrl, cors, json } = require('./_lib/oauth');
const { forUser } = require('./_lib/supabase');
const { TOOLS, INSTRUCTIONS } = require('./_lib/tools');
const { Invalid } = require('./_lib/writes');

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const text = (data, isError) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 1) }], structuredContent: data, isError });

async function handle(msg, db) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return err(msg && msg.id, -32600, 'Invalid request');
  if (msg.id === undefined) return null; // notifications need no reply
  const { id, method, params = {} } = msg;
  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[1],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'client-ledger', title: 'Client Ledger', version: '2.0.0' },
        instructions: INSTRUCTIONS
      });
    case 'ping': return ok(id, {});
    case 'tools/list': return ok(id, { tools: TOOLS.map(({ run, ...t }) => t) });
    case 'tools/call': {
      const tool = TOOLS.find(t => t.name === params.name);
      if (!tool) return err(id, -32602, 'Unknown tool: ' + params.name);
      try {
        const data = await tool.run(db, params.arguments || {});
        return ok(id, text(data, !!data.error));
      } catch (e) {
        if (!(e instanceof Invalid)) console.error(params.name, e);
        return ok(id, text({ error: e instanceof Invalid ? e.message : 'Something went wrong: ' + e.message }, true));
      }
    }
    default: return err(id, -32601, 'Method not found: ' + method);
  }
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  const base = baseUrl(req);
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
  const token = m && verify('access', m[1]);
  if (!token || token.aud !== base + '/api/mcp') {
    return json(res, 401, err(null, -32001, 'Sign in required'), {
      'WWW-Authenticate': 'Bearer resource_metadata="' + base + '/.well-known/oauth-protected-resource/api/mcp"' + (m ? ', error="invalid_token"' : '')
    });
  }
  if (req.method !== 'POST') { res.statusCode = 405; res.setHeader('Allow', 'POST'); return res.end(); }
  let b = req.body;
  if (typeof b === 'string' || Buffer.isBuffer(b)) { try { b = JSON.parse(b.toString()); } catch (e) { b = undefined; } }
  if (b == null) return json(res, 400, err(null, -32700, 'Parse error'));
  const db = forUser(token.sub);
  const out = Array.isArray(b) ? (await Promise.all(b.map(x => handle(x, db)))).filter(Boolean) : await handle(b, db);
  if (!out || (Array.isArray(out) && !out.length)) { res.statusCode = 202; return res.end(); }
  json(res, 200, out);
};
