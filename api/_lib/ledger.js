// Reads the ledger from Supabase and works out the same numbers the dashboard shows.
// Uses the service_role key, so it must only ever run on the server.

const STATUS_LABELS = { lead: 'Lead', active: 'In progress', paused: 'On hold', done: 'Done' };
const CATEGORIES = ['Domain', 'Hosting', 'Software & plugins', 'Design assets', 'Contractor', 'Ads & marketing', 'Travel', 'Other'];
const PERIODS = ['this_month', 'last_12_months', 'this_year', 'all_time'];

function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('The server is missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in its Vercel environment variables.');
  return { url: url.replace(/\/$/, ''), key };
}

async function fetchTable(table) {
  const { url, key } = config();
  // New-style secret keys (sb_secret_…) go in the apikey header only; legacy service_role keys are JWTs and also go in Authorization.
  const headers = { apikey: key };
  if (!key.startsWith('sb_')) headers.Authorization = 'Bearer ' + key;
  const res = await fetch(url + '/rest/v1/' + table + '?select=*', { headers });
  if (!res.ok) throw new Error('Supabase returned ' + res.status + ' for ' + table + ': ' + (await res.text()).slice(0, 200));
  return res.json();
}

const guessCategory = note => CATEGORIES.find(c => c.toLowerCase() === String(note || '').trim().toLowerCase()) || 'Other';
const round = n => Math.round(n * 100) / 100;

async function load() {
  const [clients, projects, txns] = await Promise.all(['clients', 'projects', 'txns'].map(fetchTable));
  const C = clients.map(r => ({ id: r.id, name: r.name, contact: r.contact || '', notes: r.notes || '', order: r.sort_order ?? 0 }));
  const P = projects.map(r => ({
    id: r.id, clientId: r.client_id, title: r.name, status: r.status || 'active', description: r.description || '',
    quoted: Number(r.quoted) || 0, previewUrl: r.preview_url || '', liveUrl: r.live_url || '', githubUrl: r.github_url || '',
    startDate: r.start_date || null, dueDate: r.due_date || null, createdAt: r.created_at
  }));
  const T = txns.map(r => ({
    id: r.id, clientId: r.client_id, projectId: r.project_id, type: r.type, amount: Number(r.amount) || 0,
    category: r.type === 'out' ? (r.category || guessCategory(r.note)) : '', note: r.note || '', date: r.date || null
  }));
  return new Ledger(C, P, T);
}

function sumOf(txns) {
  let earned = 0, spent = 0;
  txns.forEach(t => { if (t.type === 'out') spent += t.amount; else earned += t.amount; });
  return { revenue: round(earned), spending: round(spent), profit: round(earned - spent) };
}

function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

// Dates are compared as YYYY-MM-DD strings in India time, which is where the work and the money happen.
function todayIST() { return new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10); }

function periodRange(period, from, to) {
  if (from || to) return { from: from || null, to: to || null, label: (from || 'start') + ' to ' + (to || 'today') };
  const t = todayIST(), y = Number(t.slice(0, 4)), m = Number(t.slice(5, 7));
  if (period === 'this_month') return { from: t.slice(0, 7) + '-01', to: null, label: 'This month' };
  if (period === 'this_year') return { from: y + '-01-01', to: null, label: 'This year' };
  if (period === 'last_12_months') { const d = new Date(y, m - 12, 1); return { from: ymd(d), to: null, label: 'Last 12 months' }; }
  return { from: null, to: null, label: 'All time' };
}
const inRange = (t, r) => (!r.from && !r.to) ? true : !!t.date && (!r.from || t.date >= r.from) && (!r.to || t.date <= r.to);

class Ledger {
  constructor(clients, projects, txns) { this.clients = clients; this.projects = projects; this.txns = txns; }
  client(id) { return this.clients.find(c => c.id === id); }
  clientName(id) { return (this.client(id) || {}).name || 'Unknown client'; }
  project(id) { return this.projects.find(p => p.id === id); }

  // Finds by id, exact name, then partial name. Returns every match so the caller can ask which one was meant.
  find(list, query, nameOf) {
    const q = String(query || '').trim().toLowerCase();
    const byId = list.filter(x => x.id === query);
    if (byId.length) return byId;
    const exact = list.filter(x => nameOf(x).toLowerCase() === q);
    if (exact.length) return exact;
    return list.filter(x => nameOf(x).toLowerCase().includes(q));
  }

  projectStats(p, txns = this.txns) {
    const s = sumOf(txns.filter(t => t.projectId === p.id));
    const received = s.revenue;
    return {
      quoted: p.quoted, received, spent: s.spending, profit: s.profit,
      stillToCollect: p.status === 'lead' ? 0 : round(Math.max(0, p.quoted - received)),
      percentPaid: p.quoted ? Math.round(Math.min(100, received / p.quoted * 100)) : null
    };
  }

  projectSummary(p) {
    return {
      id: p.id, title: p.title, client: this.clientName(p.clientId), status: STATUS_LABELS[p.status] || p.status,
      description: p.description || null,
      links: { preview: p.previewUrl || null, live: p.liveUrl || null, github: p.githubUrl || null },
      startDate: p.startDate, dueDate: p.dueDate, overdue: !!(p.dueDate && p.status !== 'done' && p.dueDate < todayIST()),
      money: this.projectStats(p)
    };
  }

  txnSummary(t) {
    return {
      date: t.date, type: t.type === 'out' ? 'money out' : 'money in', amount: t.amount,
      client: this.clientName(t.clientId), project: t.projectId ? ((this.project(t.projectId) || {}).title || 'Deleted project') : 'No project',
      category: t.category || null, note: t.note || null
    };
  }

  summary({ period = 'all_time', from, to } = {}) {
    const r = periodRange(period, from, to);
    const tx = this.txns.filter(t => inRange(t, r));
    const s = sumOf(tx);
    const byMonth = {};
    tx.filter(t => t.date).forEach(t => {
      const k = t.date.slice(0, 7); byMonth[k] = byMonth[k] || { revenue: 0, spending: 0 };
      byMonth[k][t.type === 'out' ? 'spending' : 'revenue'] += t.amount;
    });
    const spendingByCategory = {};
    tx.filter(t => t.type === 'out').forEach(t => { spendingByCategory[t.category] = round((spendingByCategory[t.category] || 0) + t.amount); });
    const projectProfit = this.projects.map(p => ({ project: p.title, client: this.clientName(p.clientId), ...sumOf(tx.filter(t => t.projectId === p.id)) }))
      .filter(x => x.revenue || x.spending).sort((a, b) => b.profit - a.profit);
    const owed = this.projects.map(p => ({ project: p.title, client: this.clientName(p.clientId), ...this.projectStats(p) })).filter(x => x.stillToCollect > 0)
      .sort((a, b) => b.stillToCollect - a.stillToCollect).map(({ project, client, quoted, received, stillToCollect }) => ({ project, client, quoted, received, stillToCollect }));
    const counts = {}; this.projects.forEach(p => { const l = STATUS_LABELS[p.status] || p.status; counts[l] = (counts[l] || 0) + 1; });
    const undated = this.txns.filter(t => !t.date).length;
    return {
      currency: 'INR', period: r.label, ...s,
      marginPercent: s.revenue > 0 ? Math.round(s.profit / s.revenue * 100) : null,
      stillToCollect: round(owed.reduce((a, x) => a + x.stillToCollect, 0)),
      pipelineFromLeads: round(this.projects.filter(p => p.status === 'lead').reduce((a, p) => a + p.quoted, 0)),
      projectsByStatus: counts, clients: this.clients.length,
      byMonth: Object.keys(byMonth).sort().map(k => ({ month: k, revenue: round(byMonth[k].revenue), spending: round(byMonth[k].spending), profit: round(byMonth[k].revenue - byMonth[k].spending) })),
      spendingByCategory, projectsByProfit: projectProfit, stillToCollectByProject: owed,
      note: undated && r.label !== 'All time' ? undated + ' entries have no date and are only counted under all_time.' : undefined
    };
  }

  listProjects({ status, client, search } = {}) {
    let ps = this.projects;
    if (status) { const s = String(status).toLowerCase(); ps = ps.filter(p => p.status === s || (STATUS_LABELS[p.status] || '').toLowerCase() === s || (s === 'open' && p.status !== 'done')); }
    if (client) { const ids = new Set(this.find(this.clients, client, c => c.name).map(c => c.id)); ps = ps.filter(p => ids.has(p.clientId)); }
    if (search) { const q = String(search).toLowerCase(); ps = ps.filter(p => (p.title + ' ' + this.clientName(p.clientId) + ' ' + p.description).toLowerCase().includes(q)); }
    return { currency: 'INR', count: ps.length, projects: ps.map(p => this.projectSummary(p)) };
  }

  getProject({ project }) {
    // "Website", "GeekBoz Website" and "website for geekboz" should all work: try the title alone, then every word against title + client.
    const direct = this.find(this.projects, project, p => p.title);
    const words = String(project || '').toLowerCase().split(/\s+/).filter(w => w && !['for', 'of', 'the', '-', '·'].includes(w));
    const ms = direct.length ? direct : this.projects.filter(p => { const hay = (p.title + ' ' + this.clientName(p.clientId)).toLowerCase(); return words.length && words.every(w => hay.includes(w)); });
    if (!ms.length) return { error: 'No project matches "' + project + '".', projects: this.projects.map(p => p.title + ' (' + this.clientName(p.clientId) + ')') };
    if (ms.length > 1) return { error: 'Several projects match "' + project + '". Ask which one, or pass its id.', matches: ms.map(p => ({ id: p.id, title: p.title, client: this.clientName(p.clientId) })) };
    const p = ms[0];
    const tx = this.txns.filter(t => t.projectId === p.id).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    return { currency: 'INR', ...this.projectSummary(p), transactions: tx.map(t => this.txnSummary(t)) };
  }

  listClients() {
    return {
      currency: 'INR',
      clients: this.clients.slice().sort((a, b) => a.order - b.order).map(c => {
        const ps = this.projects.filter(p => p.clientId === c.id);
        return { id: c.id, name: c.name, contact: c.contact || null, projects: ps.length, openProjects: ps.filter(p => p.status !== 'done').length,
          ...sumOf(this.txns.filter(t => t.clientId === c.id)), stillToCollect: round(ps.reduce((a, p) => a + this.projectStats(p).stillToCollect, 0)) };
      })
    };
  }

  getClient({ client }) {
    const ms = this.find(this.clients, client, c => c.name);
    if (!ms.length) return { error: 'No client matches "' + client + '".', clients: this.clients.map(c => c.name) };
    if (ms.length > 1) return { error: 'Several clients match "' + client + '". Ask which one.', matches: ms.map(c => ({ id: c.id, name: c.name })) };
    const c = ms[0], tx = this.txns.filter(t => t.clientId === c.id).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    return { currency: 'INR', id: c.id, name: c.name, contact: c.contact || null, notes: c.notes || null, ...sumOf(tx),
      projects: this.projects.filter(p => p.clientId === c.id).map(p => this.projectSummary(p)), transactions: tx.map(t => this.txnSummary(t)) };
  }

  listTransactions({ type, period = 'all_time', from, to, client, project, category, limit = 100 } = {}) {
    const r = periodRange(period, from, to);
    let tx = this.txns.filter(t => inRange(t, r));
    if (type === 'in' || type === 'out') tx = tx.filter(t => t.type === type);
    if (client) { const ids = new Set(this.find(this.clients, client, c => c.name).map(c => c.id)); tx = tx.filter(t => ids.has(t.clientId)); }
    if (project) { const ids = new Set(this.find(this.projects, project, p => p.title).map(p => p.id)); tx = tx.filter(t => ids.has(t.projectId)); }
    if (category) tx = tx.filter(t => t.category.toLowerCase() === String(category).toLowerCase());
    tx.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const n = Math.max(1, Math.min(500, Number(limit) || 100));
    return { currency: 'INR', period: r.label, count: tx.length, ...sumOf(tx), transactions: tx.slice(0, n).map(t => this.txnSummary(t)),
      truncated: tx.length > n ? 'Showing the newest ' + n + ' of ' + tx.length + '.' : undefined };
  }
}

module.exports = { load, PERIODS, CATEGORIES };
