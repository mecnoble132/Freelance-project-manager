// MCP server (Streamable HTTP, stateless, read-only) so an AI assistant can answer questions about the ledger.
// Lives at /api/mcp/<MCP_SECRET>: the secret in the path is the password, so keep the full URL private.
const crypto = require('crypto');
const { load, PERIODS, CATEGORIES } = require('../_lib/ledger');

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const period = { type: 'string', enum: PERIODS, description: 'Time period. Defaults to all_time. Ignored when from or to is given.' };
const dateArg = d => ({ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: d + ' (YYYY-MM-DD).' });
const readOnly = { readOnlyHint: true, openWorldHint: false };

const TOOLS = [
  { name: 'get_summary', title: 'Business summary',
    description: 'Revenue, spending, profit and margin for a period, plus money still to collect, projects by status, month-by-month totals, spending by category and the most profitable projects. Start here for questions about how the business is doing. Amounts are in Indian rupees.',
    inputSchema: { type: 'object', properties: { period, from: dateArg('Start date, inclusive'), to: dateArg('End date, inclusive') } },
    run: (l, a) => l.summary(a) },
  { name: 'list_projects', title: 'List projects',
    description: 'Every project with its client, status, description, preview/live/GitHub links, dates, and money (quoted, received, spent, profit, still to collect). Filter by status, client or text.',
    inputSchema: { type: 'object', properties: {
      status: { type: 'string', enum: ['lead', 'active', 'paused', 'done', 'open'], description: 'lead, active (in progress), paused (on hold), done, or open (anything not done).' },
      client: { type: 'string', description: 'Client name, or part of it.' },
      search: { type: 'string', description: 'Text to look for in the title, client or description.' } } },
    run: (l, a) => l.listProjects(a) },
  { name: 'get_project', title: 'Project details',
    description: 'Everything about one project, including every payment and expense on it. If several projects share a name (e.g. "Website"), include the client name, like "GeekBoz Website", or pass the id.',
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project id, title, or "client title".' } }, required: ['project'] },
    run: (l, a) => l.getProject(a) },
  { name: 'list_clients', title: 'List clients',
    description: 'Every client with their number of projects, revenue, spending, profit and money still to collect.',
    inputSchema: { type: 'object', properties: {} },
    run: l => l.listClients() },
  { name: 'get_client', title: 'Client details',
    description: 'One client with contact, notes, totals, their projects and every payment and expense.',
    inputSchema: { type: 'object', properties: { client: { type: 'string', description: 'Client id or name.' } }, required: ['client'] },
    run: (l, a) => l.getClient(a) },
  { name: 'list_transactions', title: 'List payments and expenses',
    description: 'Payments (money in) and expenses (money out), newest first, with totals for what matched. Filter by type, period or dates, client, project and expense category.',
    inputSchema: { type: 'object', properties: {
      type: { type: 'string', enum: ['in', 'out'], description: 'in = payments received, out = expenses.' },
      period, from: dateArg('Start date, inclusive'), to: dateArg('End date, inclusive'),
      client: { type: 'string', description: 'Client name, or part of it.' },
      project: { type: 'string', description: 'Project title, or part of it.' },
      category: { type: 'string', enum: CATEGORIES, description: 'Expense category.' },
      limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Most entries to return. Defaults to 100.' } } },
    run: (l, a) => l.listTransactions(a) }
].map(t => ({ ...t, annotations: { title: t.title, ...readOnly } }));

const INSTRUCTIONS = 'Read-only access to a freelance web developer\'s Client Ledger: clients, web projects (status, description, preview/live/GitHub links, quoted price) and every payment and expense. All money is in Indian rupees (INR). "Still to collect" is quoted price minus money received, for projects that are not leads. Some older entries have no date; they only count when the period is all_time.';

function secretMatches(given) {
  const want = process.env.MCP_SECRET || '';
  if (want.length < 24 || typeof given !== 'string') return false;
  const a = Buffer.from(given), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function handle(msg) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return err(msg && msg.id, -32600, 'Invalid request');
  const isNotification = msg.id === undefined;
  if (isNotification) return null;
  const { id, method, params = {} } = msg;
  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[1],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'client-ledger', title: 'Client Ledger', version: '1.0.0' },
        instructions: INSTRUCTIONS
      });
    case 'ping': return ok(id, {});
    case 'tools/list': return ok(id, { tools: TOOLS.map(({ run, ...t }) => t) });
    case 'tools/call': {
      const tool = TOOLS.find(t => t.name === params.name);
      if (!tool) return err(id, -32602, 'Unknown tool: ' + params.name);
      try {
        const data = await tool.run(await load(), params.arguments || {});
        return ok(id, { content: [{ type: 'text', text: JSON.stringify(data, null, 1) }], structuredContent: data, isError: !!data.error });
      } catch (e) {
        return ok(id, { content: [{ type: 'text', text: 'Couldn\'t read the ledger: ' + e.message }], isError: true });
      }
    }
    default: return err(id, -32601, 'Method not found: ' + method);
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!secretMatches(req.query && req.query.key)) { res.statusCode = 404; return res.end('Not found'); }
  if (req.method !== 'POST') { res.statusCode = 405; res.setHeader('Allow', 'POST'); return res.end(); }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = undefined; } }
  if (body === undefined || body === null) { res.statusCode = 400; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(err(null, -32700, 'Parse error'))); }
  const out = Array.isArray(body) ? (await Promise.all(body.map(handle))).filter(Boolean) : await handle(body);
  if (!out || (Array.isArray(out) && !out.length)) { res.statusCode = 202; return res.end(); }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(out));
};
