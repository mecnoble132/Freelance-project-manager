// Loads one user's ledger and works out the same numbers the dashboard shows.

const STATUS_LABELS = { lead: 'Lead', active: 'In progress', paused: 'On hold', done: 'Done' };
const STATUSES = Object.keys(STATUS_LABELS);
const CATEGORIES = ['Domain', 'Hosting', 'Software & plugins', 'Design assets', 'Contractor', 'Ads & marketing', 'Travel', 'Other'];
const PERIODS = ['this_month', 'last_month', 'last_12_months', 'this_fy', 'last_fy', 'this_year', 'last_year', 'all_time'];

const guessCategory = note => CATEGORIES.find(c => c.toLowerCase() === String(note || '').trim().toLowerCase()) || 'Other';
const round = n => Math.round(n * 100) / 100;
const pad = n => String(n).padStart(2, '0');

// Dates are YYYY-MM-DD strings in India time, which is where the work and the money happen.
function todayIST() { return new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10); }
function monthStart(y, m) { const d = new Date(Date.UTC(y, m - 1, 1)); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-01'; }
function monthEnd(y, m) { const d = new Date(Date.UTC(y, m, 0)); return d.toISOString().slice(0, 10); }
// Indian financial years run April to March: FY 2026–27 is 2026-04-01 to 2027-03-31.
const fyLabel = y => 'FY ' + y + '–' + String(y + 1).slice(2);
const fyRange = y => ({ from: y + '-04-01', to: (y + 1) + '-03-31', label: fyLabel(y) });

function periodRange(period, from, to) {
  if (from || to) return { from: from || null, to: to || null, label: (from || 'start') + ' to ' + (to || 'today') };
  const t = todayIST(), y = Number(t.slice(0, 4)), m = Number(t.slice(5, 7));
  switch (period) {
    case 'this_month': return { from: monthStart(y, m), to: null, label: 'This month' };
    case 'last_month': return { from: monthStart(y, m - 1), to: monthEnd(y, m - 1), label: 'Last month' };
    case 'this_fy': return fyRange(m >= 4 ? y : y - 1);
    case 'last_fy': return fyRange(m >= 4 ? y - 1 : y - 2);
    case 'this_year': return { from: y + '-01-01', to: null, label: 'This year' };
    case 'last_year': return { from: (y - 1) + '-01-01', to: (y - 1) + '-12-31', label: 'Last year' };
    case 'last_12_months': return { from: monthStart(y, m - 11), to: null, label: 'Last 12 months' };
    default: return { from: null, to: null, label: 'All time' };
  }
}
const inRange = (t, r) => (!r.from && !r.to) ? true : !!t.date && (!r.from || t.date >= r.from) && (!r.to || t.date <= r.to);

function sumOf(txns) {
  let earned = 0, spent = 0;
  txns.forEach(t => { if (t.type === 'out') spent += t.amount; else earned += t.amount; });
  return { revenue: round(earned), spending: round(spent), profit: round(earned - spent) };
}

async function load(db) {
  const [clients, projects, txns, milestones] = await Promise.all(['clients', 'projects', 'txns', 'milestones'].map(t => db.select(t)));
  return new Ledger(clients, projects, txns, milestones);
}

class Ledger {
  constructor(clients, projects, txns, milestones = []) {
    this.raw = { clients, projects, txns, milestones };
    this.clients = clients.map(r => ({ id: r.id, name: r.name, contact: r.contact || '', notes: r.notes || '', order: r.sort_order ?? 0 }));
    this.projects = projects.map(r => ({
      id: r.id, clientId: r.client_id, title: r.name, status: r.status || 'active', description: r.description || '',
      quoted: Number(r.quoted) || 0, previewUrl: r.preview_url || '', liveUrl: r.live_url || '', githubUrl: r.github_url || '',
      startDate: r.start_date || null, dueDate: r.due_date || null, createdAt: r.created_at
    }));
    this.txns = txns.map(r => ({
      id: r.id, clientId: r.client_id, projectId: r.project_id, type: r.type, amount: Number(r.amount) || 0,
      category: r.type === 'out' ? (r.category || guessCategory(r.note)) : '', note: r.note || '', date: r.date || null
    }));
    this.milestoneRows = milestones.map(r => ({ id: r.id, projectId: r.project_id, name: r.name || '', amount: Number(r.amount) || 0, dueDate: r.due_date || null, order: r.sort_order ?? 0, createdAt: r.created_at || '' }));
  }
  client(id) { return this.clients.find(c => c.id === id); }
  clientName(id) { return (this.client(id) || {}).name || 'Unknown client'; }
  project(id) { return this.projects.find(p => p.id === id); }
  projectLabel(p) { return p.title + ' (' + this.clientName(p.clientId) + ')'; }

  // Finds by id, exact name, then partial name. Returns every match so the caller can ask which one was meant.
  find(list, query, nameOf) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const byId = list.filter(x => x.id === query);
    if (byId.length) return byId;
    const exact = list.filter(x => nameOf(x).toLowerCase() === q);
    if (exact.length) return exact;
    return list.filter(x => nameOf(x).toLowerCase().includes(q));
  }

  // { client } when exactly one client matches, otherwise { error, ... } to hand back to the assistant.
  resolveClient(query) {
    const ms = this.find(this.clients, query, c => c.name);
    if (ms.length === 1) return { client: ms[0] };
    if (!ms.length) return { error: 'No client matches "' + query + '".', clients: this.clients.map(c => c.name) };
    return { error: 'Several clients match "' + query + '". Ask which one, or pass its id.', matches: ms.map(c => ({ id: c.id, name: c.name })) };
  }

  // "Website", "GeekBoz Website" and "website for geekboz" all work. An optional client narrows the search.
  resolveProject(query, clientQuery) {
    let pool = this.projects;
    if (clientQuery) { const r = this.resolveClient(clientQuery); if (r.error) return r; pool = pool.filter(p => p.clientId === r.client.id); }
    const direct = this.find(pool, query, p => p.title);
    const words = String(query || '').toLowerCase().split(/\s+/).filter(w => w && !['for', 'of', 'the', '-', '·'].includes(w));
    const ms = direct.length ? direct : pool.filter(p => { const hay = (p.title + ' ' + this.clientName(p.clientId)).toLowerCase(); return words.length && words.every(w => hay.includes(w)); });
    if (ms.length === 1) return { project: ms[0] };
    if (!ms.length) return { error: 'No project matches "' + query + '"' + (clientQuery ? ' for ' + clientQuery : '') + '.', projects: pool.map(p => this.projectLabel(p)) };
    return { error: 'Several projects match "' + query + '". Ask which one, or pass the client or the id.', matches: ms.map(p => ({ id: p.id, title: p.title, client: this.clientName(p.clientId) })) };
  }

  projectStats(p, txns = this.txns) {
    const s = sumOf(txns.filter(t => t.projectId === p.id));
    return {
      quoted: p.quoted, received: s.revenue, spent: s.spending, profit: s.profit,
      stillToCollect: p.status === 'lead' ? 0 : round(Math.max(0, p.quoted - s.revenue)),
      percentPaid: p.quoted ? Math.round(Math.min(100, s.revenue / p.quoted * 100)) : null
    };
  }

  // A project's money in pays off its milestones in order. One is overdue when its due date has passed and it isn't
  // fully paid; leads aren't owed anything yet, so their milestones are never overdue.
  milestones(p) {
    const t = todayIST();
    let left = sumOf(this.txns.filter(x => x.projectId === p.id)).revenue;
    return this.milestoneRows.filter(m => m.projectId === p.id).sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt)).map(m => {
      const paid = round(Math.min(m.amount, left)); left = round(left - paid);
      const owing = round(m.amount - paid);
      const overdue = owing > 0 && p.status !== 'lead' && !!m.dueDate && m.dueDate < t;
      return { id: m.id, name: m.name, amount: m.amount, dueDate: m.dueDate, paid, left: owing,
        state: !owing ? 'paid' : overdue ? 'overdue' : paid ? 'part-paid' : 'unpaid',
        daysOverdue: overdue ? Math.round((Date.parse(t) - Date.parse(m.dueDate)) / 864e5) : undefined };
    });
  }

  // Overdue milestones, and unpaid ones due in the next 7 days, across every project.
  milestoneAlerts() {
    const t = todayIST(), soon = new Date(Date.now() + 5.5 * 3600e3 + 7 * 864e5).toISOString().slice(0, 10);
    const overdue = [], dueWithinAWeek = [];
    this.projects.forEach(p => this.milestones(p).forEach(m => {
      const item = { projectId: p.id, project: this.projectLabel(p), milestone: m.name, amount: m.amount, left: m.left, dueDate: m.dueDate };
      if (m.state === 'overdue') overdue.push({ ...item, daysOverdue: m.daysOverdue });
      else if (m.left && p.status !== 'lead' && m.dueDate && m.dueDate >= t && m.dueDate <= soon) dueWithinAWeek.push(item);
    }));
    overdue.sort((a, b) => a.dueDate.localeCompare(b.dueDate)); dueWithinAWeek.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    return { overdue, dueWithinAWeek, overdueTotal: round(overdue.reduce((a, m) => a + m.left, 0)) };
  }

  projectSummary(p) {
    const ms = this.milestones(p);
    return {
      id: p.id, title: p.title, client: this.clientName(p.clientId), clientId: p.clientId, status: STATUS_LABELS[p.status] || p.status,
      description: p.description || null,
      links: { preview: p.previewUrl || null, live: p.liveUrl || null, github: p.githubUrl || null },
      startDate: p.startDate, dueDate: p.dueDate, overdue: !!(p.dueDate && p.status !== 'done' && p.dueDate < todayIST()),
      money: { ...this.projectStats(p), ...(ms.length ? { overdue: round(ms.reduce((a, m) => a + (m.state === 'overdue' ? m.left : 0), 0)) } : {}) },
      ...(ms.length ? { milestones: ms } : {})
    };
  }

  txnSummary(t) {
    return {
      id: t.id, date: t.date, type: t.type === 'out' ? 'money out' : 'money in', amount: t.amount,
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
    const owed = this.owed();
    const counts = {}; this.projects.forEach(p => { const l = STATUS_LABELS[p.status] || p.status; counts[l] = (counts[l] || 0) + 1; });
    const undated = this.txns.filter(t => !t.date).length;
    const ms = this.milestoneAlerts();
    return {
      currency: 'INR', period: r.label, from: r.from, to: r.to, ...s,
      marginPercent: s.revenue > 0 ? Math.round(s.profit / s.revenue * 100) : null,
      payments: tx.filter(t => t.type !== 'out').length, expenses: tx.filter(t => t.type === 'out').length,
      stillToCollect: round(owed.reduce((a, x) => a + x.stillToCollect, 0)),
      overdueFromMilestones: ms.overdueTotal, overdueMilestones: ms.overdue, milestonesDueWithinAWeek: ms.dueWithinAWeek,
      pipelineFromLeads: round(this.projects.filter(p => p.status === 'lead').reduce((a, p) => a + p.quoted, 0)),
      projectsByStatus: counts, clients: this.clients.length,
      byMonth: Object.keys(byMonth).sort().map(k => ({ month: k, revenue: round(byMonth[k].revenue), spending: round(byMonth[k].spending), profit: round(byMonth[k].revenue - byMonth[k].spending) })),
      spendingByCategory, projectsByProfit: projectProfit, stillToCollectByProject: owed,
      note: undated && r.label !== 'All time' ? undated + ' entries have no date and are only counted under all_time.' : undefined
    };
  }

  owed() {
    return this.projects.map(p => ({ p, s: this.projectStats(p) })).filter(x => x.s.stillToCollect > 0)
      .sort((a, b) => b.s.stillToCollect - a.s.stillToCollect)
      .map(({ p, s }) => ({ projectId: p.id, project: p.title, client: this.clientName(p.clientId), status: STATUS_LABELS[p.status], quoted: s.quoted, received: s.received, stillToCollect: s.stillToCollect }));
  }

  comparePeriods({ preset, a_from, a_to, b_from, b_to } = {}) {
    let a, b;
    if (preset === 'fy_vs_last_fy') { a = { period: 'this_fy' }; b = { period: 'last_fy' }; }
    else if (preset === 'year_vs_last_year') { a = { period: 'this_year' }; b = { period: 'last_year' }; }
    else if (preset === 'last_12_vs_previous_12') {
      const t = todayIST(), y = Number(t.slice(0, 4)), m = Number(t.slice(5, 7));
      a = { period: 'last_12_months' }; b = { from: monthStart(y, m - 23), to: monthEnd(y, m - 12) };
    } else if (a_from || a_to || b_from || b_to) { a = { from: a_from, to: a_to }; b = { from: b_from, to: b_to }; }
    else { a = { period: 'this_month' }; b = { period: 'last_month' }; }
    const pick = x => { const s = this.summary(x); return { period: s.period, from: s.from, to: s.to, revenue: s.revenue, spending: s.spending, profit: s.profit, marginPercent: s.marginPercent, payments: s.payments, expenses: s.expenses, spendingByCategory: s.spendingByCategory }; };
    const A = pick(a), B = pick(b);
    const change = k => ({ difference: round(A[k] - B[k]), percent: B[k] ? Math.round((A[k] - B[k]) / Math.abs(B[k]) * 100) : null });
    return { currency: 'INR', current: A, previous: B, change: { revenue: change('revenue'), spending: change('spending'), profit: change('profit') },
      note: this.txns.some(t => !t.date) ? 'Entries without a date are not in either period.' : undefined };
  }

  // Things worth acting on: overdue work, money owed, leads, and gaps in the data.
  attention() {
    const t = todayIST();
    const open = this.projects.filter(p => p.status !== 'done');
    const soon = new Date(Date.now() + 5.5 * 3600e3 + 7 * 864e5).toISOString().slice(0, 10);
    const ms = this.milestoneAlerts();
    const lastPaid = p => this.txns.filter(x => x.projectId === p.id && x.type !== 'out' && x.date).map(x => x.date).sort().pop() || null;
    return {
      currency: 'INR', today: t,
      overdueProjects: open.filter(p => p.dueDate && p.dueDate < t).map(p => ({ id: p.id, project: this.projectLabel(p), dueDate: p.dueDate, status: STATUS_LABELS[p.status] })),
      dueWithinAWeek: open.filter(p => p.dueDate && p.dueDate >= t && p.dueDate <= soon).map(p => ({ id: p.id, project: this.projectLabel(p), dueDate: p.dueDate })),
      overdueMilestones: ms.overdue, milestonesDueWithinAWeek: ms.dueWithinAWeek,
      stillToCollect: this.owed().map(o => ({ ...o, lastPayment: lastPaid(this.project(o.projectId)) })),
      openLeads: this.projects.filter(p => p.status === 'lead').map(p => ({ id: p.id, project: this.projectLabel(p), quoted: p.quoted, added: (p.createdAt || '').slice(0, 10) })),
      onHold: this.projects.filter(p => p.status === 'paused').map(p => ({ id: p.id, project: this.projectLabel(p) })),
      missingInfo: {
        projectsWithoutQuote: this.projects.filter(p => p.status !== 'lead' && !p.quoted).map(p => this.projectLabel(p)),
        projectsWithoutLiveLink: this.projects.filter(p => p.status === 'done' && !p.liveUrl).map(p => this.projectLabel(p)),
        entriesWithoutDate: this.txns.filter(x => !x.date).length
      }
    };
  }

  search({ query }) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return { error: 'Give some text to search for.' };
    const has = s => String(s || '').toLowerCase().includes(q);
    return {
      currency: 'INR', query,
      clients: this.clients.filter(c => has(c.name) || has(c.contact) || has(c.notes)).map(c => ({ id: c.id, name: c.name, contact: c.contact || null })),
      projects: this.projects.filter(p => has(p.title) || has(p.description) || has(p.previewUrl) || has(p.liveUrl) || has(p.githubUrl) || has(this.clientName(p.clientId)))
        .map(p => ({ id: p.id, title: p.title, client: this.clientName(p.clientId), status: STATUS_LABELS[p.status] })),
      transactions: this.txns.filter(t => has(t.note) || has(t.category)).slice(0, 50).map(t => this.txnSummary(t))
    };
  }

  listProjects({ status, client, search } = {}) {
    let ps = this.projects;
    if (status) { const s = String(status).toLowerCase(); ps = ps.filter(p => p.status === s || (STATUS_LABELS[p.status] || '').toLowerCase() === s || (s === 'open' && p.status !== 'done')); }
    if (client) { const ids = new Set(this.find(this.clients, client, c => c.name).map(c => c.id)); ps = ps.filter(p => ids.has(p.clientId)); }
    if (search) { const q = String(search).toLowerCase(); ps = ps.filter(p => (p.title + ' ' + this.clientName(p.clientId) + ' ' + p.description).toLowerCase().includes(q)); }
    return { currency: 'INR', count: ps.length, projects: ps.map(p => this.projectSummary(p)) };
  }

  getProject({ project, client }) {
    const r = this.resolveProject(project, client);
    if (r.error) return r;
    const p = r.project;
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
    const r = this.resolveClient(client);
    if (r.error) return r;
    const c = r.client, tx = this.txns.filter(t => t.clientId === c.id).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
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

module.exports = { load, Ledger, PERIODS, CATEGORIES, STATUSES, STATUS_LABELS, todayIST, guessCategory, round };
