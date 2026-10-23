// Changes made through the MCP server. Each tool call is one "change": every row it inserts, updates or deletes
// is recorded in activity_log under one batch id, so the whole call can be listed and undone.
const crypto = require('crypto');
const { load, Ledger, CATEGORIES, STATUSES, todayIST, guessCategory, round, nextInvoiceNumber, addDays, addMonths, niceDate, CYCLE_MONTHS, SERVICE_KINDS, KIND_CATEGORY } = require('./ledger');

class Invalid extends Error {}
const fail = msg => { throw new Invalid(msg); };

// ---------- input cleaning ----------
const text = (v, max = 5000) => v == null ? '' : String(v).trim().slice(0, max);
function money(v, { allowZero = false, label = 'Amount' } = {}) {
  const n = typeof v === 'string' ? Number(v.replace(/[₹,\s]/g, '')) : Number(v);
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) fail(label + ' must be a number' + (allowZero ? ' of 0 or more' : ' above 0') + '.');
  if (n > 1e10) fail(label + ' is too large.');
  return Math.round(n * 100) / 100;
}
function date(v, label) {
  if (v === null || v === '') return null;
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(Date.parse(s + 'T00:00:00Z')) || new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) !== s) fail(label + ' must be a real date written as YYYY-MM-DD.');
  return s;
}
// Same rule as the website: only http(s) links, and "https://" is added when left off.
function url(v, label) {
  let u = text(v, 2000);
  if (!u) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
  try { const x = new URL(u); if (/^https?:$/.test(x.protocol)) return x.href; } catch (e) {}
  fail(label + ' doesn\'t look like a web address.');
}
function status(v) {
  const s = text(v).toLowerCase().replace(/[\s-]+/g, '_');
  const map = { in_progress: 'active', on_hold: 'paused', completed: 'done', finished: 'done' };
  const r = map[s] || s;
  if (!STATUSES.includes(r)) fail('Status must be one of: lead, active (in progress), paused (on hold), done.');
  return r;
}
function category(v, note) {
  if (v == null || v === '') return guessCategory(note);
  const c = CATEGORIES.find(x => x.toLowerCase() === String(v).trim().toLowerCase());
  if (!c) fail('Category must be one of: ' + CATEGORIES.join(', ') + '.');
  return c;
}
const given = v => v !== undefined;

// ---------- change log ----------
class Change {
  constructor(db, summary) { this.db = db; this.batch = crypto.randomUUID(); this.summary = summary; this.entries = []; }
  // Writes refuse to start when the activity log is missing, so nothing is ever changed without a way to undo it.
  async ready() {
    try { await this.db.select('activity_log', { batch_id: this.batch }); }
    catch (e) { fail('The activity_log table is missing, so changes can\'t be recorded or undone. Run supabase/schema.sql in the Supabase SQL editor first.'); }
  }
  log(op, table, rowId, before, after) {
    this.entries.push({ batch_id: this.batch, seq: this.entries.length, source: 'mcp', summary: this.summary, op, table_name: table, row_id: rowId, before, after });
  }
  async insert(table, rows) {
    const out = await this.db.insert(table, rows);
    out.forEach(r => this.log('insert', table, r.id, null, r));
    return out;
  }
  async update(table, before, patch) {
    const [r] = await this.db.update(table, before.id, patch);
    if (!r) fail('That ' + table.replace(/s$/, '') + ' no longer exists.');
    const old = {}; Object.keys(patch).forEach(k => { old[k] = before[k] ?? null; });
    this.log('update', table, r.id, old, patch);
    return r;
  }
  async remove(table, row) {
    await this.db.remove(table, row.id);
    this.log('delete', table, row.id, row, null);
  }
  async commit() {
    if (this.entries.length) await this.db.insert('activity_log', this.entries);
    return this.batch;
  }
}
const done = (message, extra, batch) => ({ done: true, message, ...extra, change_id: batch, undo: 'If this was a mistake, call undo_change with this change_id.' });
const confirmFirst = (what, details) => ({ confirmation_required: true, message: 'Nothing has been changed yet. Show the user exactly what will be ' + what + ', and call this tool again with confirm: true only after they agree.', ...details });

// ---------- clients ----------
async function createClient(db, a) {
  const L = await load(db);
  const name = text(a.name, 200); if (!name) fail('Give the client a name.');
  const dupe = L.clients.find(c => c.name.toLowerCase() === name.toLowerCase());
  if (dupe && !a.allow_duplicate) return { error: 'A client called "' + dupe.name + '" already exists. Use it, or pass allow_duplicate: true if this really is a different client.', existing: { id: dupe.id, name: dupe.name } };
  const ch = new Change(db, 'Added client ' + name); await ch.ready();
  const [c] = await ch.insert('clients', { name, contact: text(a.contact, 500), notes: text(a.notes), sort_order: L.clients.length });
  return done('Added client ' + name + '.', { client: { id: c.id, name: c.name } }, await ch.commit());
}

async function updateClient(db, a) {
  const L = await load(db);
  const r = L.resolveClient(a.client); if (r.error) return r;
  const before = L.raw.clients.find(x => x.id === r.client.id), patch = {};
  if (given(a.name)) { patch.name = text(a.name, 200); if (!patch.name) fail('The client name can\'t be empty.'); }
  if (given(a.contact)) patch.contact = text(a.contact, 500);
  if (given(a.notes)) patch.notes = text(a.notes);
  if (!Object.keys(patch).length) fail('Say what to change: name, contact or notes.');
  const ch = new Change(db, 'Edited client ' + before.name); await ch.ready();
  const c = await ch.update('clients', before, patch);
  return done('Updated ' + c.name + ' (' + Object.keys(patch).join(', ') + ').', { client: { id: c.id, name: c.name, contact: c.contact, notes: c.notes } }, await ch.commit());
}

async function deleteClient(db, a) {
  const L = await load(db);
  const r = L.resolveClient(a.client); if (r.error) return r;
  const c = L.raw.clients.find(x => x.id === r.client.id);
  const projects = L.raw.projects.filter(p => p.client_id === c.id), txns = L.raw.txns.filter(t => t.client_id === c.id);
  const milestones = L.raw.milestones.filter(m => projects.some(p => p.id === m.project_id)), invoices = L.raw.invoices.filter(i => i.client_id === c.id);
  const services = L.raw.services.filter(x => x.client_id === c.id);
  const tasks = L.raw.tasks.filter(t => projects.some(p => p.id === t.project_id)), timeEntries = L.raw.time_entries.filter(e => projects.some(p => p.id === e.project_id));
  if (a.confirm !== true) return confirmFirst('deleted', { client: c.name, projects: projects.map(p => p.name), transactions: txns.length, invoices: invoices.map(i => i.number), services: services.map(x => x.name),
    tasks: tasks.length, timeEntries: timeEntries.length,
    moneyIn: txns.filter(t => t.type !== 'out').reduce((s, t) => s + Number(t.amount), 0), moneyOut: txns.filter(t => t.type === 'out').reduce((s, t) => s + Number(t.amount), 0) });
  const ch = new Change(db, 'Deleted client ' + c.name + ' with ' + projects.length + ' projects and ' + txns.length + ' entries'); await ch.ready();
  for (const t of txns) await ch.remove('txns', t);
  for (const i of invoices) await ch.remove('invoices', i);
  for (const x of services) await ch.remove('services', x);
  for (const m of milestones) await ch.remove('milestones', m);
  for (const t of tasks) await ch.remove('tasks', t);
  for (const e of timeEntries) await ch.remove('time_entries', e);
  for (const p of projects) await ch.remove('projects', p);
  await ch.remove('clients', c);
  return done('Deleted ' + c.name + ', their ' + projects.length + ' projects and ' + txns.length + ' money entries.', {}, await ch.commit());
}

// ---------- projects ----------
function projectFields(a, partial) {
  const f = {};
  if (given(a.title)) { f.name = text(a.title, 200); if (!f.name) fail('The project title can\'t be empty.'); }
  if (given(a.status)) f.status = status(a.status);
  if (given(a.quoted)) f.quoted = a.quoted === null || a.quoted === '' ? 0 : money(a.quoted, { allowZero: true, label: 'Quoted price' });
  if (given(a.start_date)) f.start_date = date(a.start_date, 'Start date');
  if (given(a.due_date)) f.due_date = date(a.due_date, 'Due date');
  if (given(a.preview_url)) f.preview_url = url(a.preview_url, 'The preview link');
  if (given(a.live_url)) f.live_url = url(a.live_url, 'The live site link');
  if (given(a.github_url)) f.github_url = url(a.github_url, 'The GitHub link');
  if (given(a.description)) f.description = text(a.description);
  if (!partial) f.name || fail('Give the project a title.');
  return f;
}

async function createProject(db, a) {
  const L = await load(db);
  const f = projectFields(a, false);
  const ch = new Change(db, 'Added project ' + f.name); await ch.ready();
  let clientId, clientName, newClient = false;
  const r = L.resolveClient(a.client);
  if (!r.error) { clientId = r.client.id; clientName = r.client.name; }
  else if (a.new_client === true && r.clients && text(a.client)) { // only when no client matches at all, never for an ambiguous name
    clientName = text(a.client, 200);
    const [c] = await ch.insert('clients', { name: clientName, contact: text(a.client_contact, 500), notes: '', sort_order: L.clients.length });
    clientId = c.id; newClient = true;
  } else return { ...r, hint: 'If this is a new client, check the spelling with the user, then call again with new_client: true to create them.' };
  const dupe = L.projects.find(p => p.clientId === clientId && p.title.toLowerCase() === f.name.toLowerCase());
  if (dupe && !a.allow_duplicate) return { error: clientName + ' already has a project called "' + dupe.title + '". Update that one, or pass allow_duplicate: true for a separate project.', existing: { id: dupe.id } };
  const [p] = await ch.insert('projects', { client_id: clientId, name: f.name, status: f.status || 'active', quoted: f.quoted || 0,
    start_date: f.start_date ?? null, due_date: f.due_date ?? null, preview_url: f.preview_url || '', live_url: f.live_url || '', github_url: f.github_url || '', description: f.description || '' });
  return done('Added project "' + p.name + '" for ' + clientName + (newClient ? ' (new client)' : '') + '.', { project: { id: p.id, title: p.name, client: clientName, newClient } }, await ch.commit());
}

async function updateProject(db, a) {
  const L = await load(db);
  const r = L.resolveProject(a.project, a.client); if (r.error) return r;
  const before = L.raw.projects.find(x => x.id === r.project.id);
  const patch = projectFields(a, true);
  if (given(a.move_to_client) && a.move_to_client) { const c = L.resolveClient(a.move_to_client); if (c.error) return c; patch.client_id = c.client.id; }
  if (!Object.keys(patch).length) fail('Say what to change on the project.');
  const ch = new Change(db, 'Edited project ' + before.name); await ch.ready();
  if (patch.client_id && patch.client_id !== before.client_id) {
    // The project's money moves with it, so client totals stay right.
    for (const t of L.raw.txns.filter(t => t.project_id === before.id)) await ch.update('txns', t, { client_id: patch.client_id });
  }
  const p = await ch.update('projects', before, patch);
  const now = new Ledger(L.raw.clients, L.raw.projects.map(x => x.id === p.id ? p : x), L.raw.txns, L.raw.milestones, L.raw.invoices, L.raw.settings, L.raw.services, L.raw.tasks, L.raw.time_entries);
  return done('Updated "' + p.name + '" (' + Object.keys(patch).map(k => ({ name: 'title', client_id: 'client' })[k] || k).join(', ') + ').', { project: now.projectSummary(now.project(p.id)) }, await ch.commit());
}

async function deleteProject(db, a) {
  const L = await load(db);
  const r = L.resolveProject(a.project, a.client); if (r.error) return r;
  const p = L.raw.projects.find(x => x.id === r.project.id), txns = L.raw.txns.filter(t => t.project_id === p.id);
  const milestones = L.raw.milestones.filter(m => m.project_id === p.id), invoices = L.raw.invoices.filter(i => i.project_id === p.id);
  const tasks = L.raw.tasks.filter(t => t.project_id === p.id), timeEntries = L.raw.time_entries.filter(e => e.project_id === p.id);
  const label = p.name + ' (' + L.clientName(p.client_id) + ')';
  if (a.confirm !== true) return confirmFirst('deleted', { project: label, transactions: txns.length, milestones: milestones.length, tasks: tasks.length, timeEntries: timeEntries.length,
    whatHappensToMoney: txns.length ? (a.delete_transactions ? 'Its ' + txns.length + ' money entries will be deleted too.' : 'Its ' + txns.length + ' money entries stay with the client under "No project". Pass delete_transactions: true to delete them instead.') : 'It has no money entries.' });
  const ch = new Change(db, 'Deleted project ' + label); await ch.ready();
  for (const t of txns) { if (a.delete_transactions) await ch.remove('txns', t); else await ch.update('txns', t, { project_id: null }); }
  for (const i of invoices) await ch.update('invoices', i, { project_id: null, milestone_id: null }); // invoices stay with the client
  for (const x of L.raw.services.filter(x => x.project_id === p.id)) await ch.update('services', x, { project_id: null }); // and so do services
  for (const m of milestones) await ch.remove('milestones', m);
  for (const t of tasks) await ch.remove('tasks', t);
  for (const e of timeEntries) await ch.remove('time_entries', e);
  await ch.remove('projects', p);
  return done('Deleted ' + label + (txns.length ? (a.delete_transactions ? ' and its ' + txns.length + ' money entries.' : '. Its ' + txns.length + ' money entries are now under "No project".') : '.'), {}, await ch.commit());
}

// ---------- money ----------
// Works out client_id and project_id for an entry from a project and/or client name.
function placeEntry(L, e) {
  if (text(e.project)) {
    const r = L.resolveProject(e.project, e.client); if (r.error) return r;
    return { client_id: r.project.clientId, project_id: r.project.id, label: L.projectLabel(r.project) };
  }
  if (!text(e.client)) return { error: 'Say which client (and ideally which project) this money is for.' };
  const r = L.resolveClient(e.client); if (r.error) return r;
  return { client_id: r.client.id, project_id: null, label: r.client.name + ' (no project)' };
}

function entryRow(L, e, i) {
  const where = i === undefined ? '' : 'Entry ' + (i + 1) + ': ';
  const type = e.type === 'out' || e.type === 'expense' ? 'out' : e.type === 'in' || e.type === 'payment' ? 'in' : fail(where + 'type must be "in" (payment) or "out" (expense).');
  // A payment for an invoice goes to the invoice's client and project.
  let inv = null;
  if (text(e.invoice)) {
    const r = L.resolveInvoice(e.invoice); if (r.error) return { ...r, error: where + r.error, error_only: true };
    inv = r.invoice;
    if (type === 'out') fail(where + 'Only payments (money in) can be for an invoice.');
    if (inv.status === 'cancelled') return { error: where + inv.number + ' is cancelled, so nothing is owed on it.', error_only: true };
  }
  const place = inv ? { client_id: inv.clientId, project_id: inv.projectId, label: inv.number + ' (' + L.clientName(inv.clientId) + ')' } : placeEntry(L, e);
  if (place.error) return { ...place, error: where + place.error, error_only: true };
  const note = text(e.note, 500);
  return { row: { client_id: place.client_id, project_id: place.project_id, type, amount: money(e.amount, { label: where + 'Amount' }),
    category: type === 'out' ? category(e.category, note) : '', note, date: e.date === undefined ? todayIST() : date(e.date, where + 'Date'), ...(inv ? { invoice_id: inv.id } : {}) }, label: place.label };
}

async function addTransactions(db, entries, summaryWord) {
  if (!Array.isArray(entries) || !entries.length) fail('Give at least one entry.');
  if (entries.length > 200) fail('Add at most 200 entries at a time.');
  const L = await load(db);
  const built = entries.map((e, i) => entryRow(L, e, entries.length > 1 ? i : undefined));
  const bad = built.filter(b => b.error);
  if (bad.length) return { error: 'Nothing was saved. ' + bad.map(b => b.error).join(' '), details: bad.map(({ error_only, row, label, ...b }) => b) };
  const sum = t => built.filter(b => b.row.type === t).reduce((s, b) => s + b.row.amount, 0);
  const ch = new Change(db, summaryWord || ('Added ' + built.length + ' money entries')); await ch.ready();
  const rows = await ch.insert('txns', built.map(b => b.row));
  const L2 = new Ledger(L.raw.clients, L.raw.projects, rows, [], L.raw.invoices);
  return done((built.length === 1 ? 'Saved ' : 'Saved ' + built.length + ' entries: ') + (sum('in') ? '₹' + sum('in').toLocaleString('en-IN') + ' in' : '') + (sum('in') && sum('out') ? ', ' : '') + (sum('out') ? '₹' + sum('out').toLocaleString('en-IN') + ' out' : '') + '.',
    { entries: rows.map(r => L2.txnSummary(L2.txns.find(t => t.id === r.id))) }, await ch.commit());
}

async function updateTransaction(db, a) {
  const L = await load(db);
  const before = L.raw.txns.find(t => t.id === a.id);
  if (!before) return { error: 'No money entry has id ' + a.id + '. Use list_transactions to find it.' };
  const patch = {};
  if (given(a.type)) patch.type = a.type === 'out' || a.type === 'expense' ? 'out' : a.type === 'in' || a.type === 'payment' ? 'in' : fail('type must be "in" or "out".');
  if (given(a.amount)) patch.amount = money(a.amount);
  if (given(a.date)) patch.date = date(a.date, 'Date');
  if (given(a.note)) patch.note = text(a.note, 500);
  const type = patch.type || before.type;
  if (given(a.category) || given(a.type)) patch.category = type === 'out' ? category(a.category ?? before.category, patch.note ?? before.note) : '';
  if (given(a.invoice)) {
    if (!a.invoice) patch.invoice_id = null;
    else { const r = L.resolveInvoice(a.invoice); if (r.error) return r; if (r.invoice.status === 'cancelled') return { error: r.invoice.number + ' is cancelled.' };
      patch.invoice_id = r.invoice.id; patch.client_id = r.invoice.clientId; patch.project_id = r.invoice.projectId; }
  }
  if (given(a.project) || given(a.client)) {
    if (given(a.project) && !a.project) { patch.project_id = null; if (a.client) { const c = L.resolveClient(a.client); if (c.error) return c; patch.client_id = c.client.id; } }
    else { const place = placeEntry(L, { project: a.project, client: a.client }); if (place.error) return place; patch.client_id = place.client_id; patch.project_id = place.project_id; }
  }
  if (!Object.keys(patch).length) fail('Say what to change on the entry.');
  const ch = new Change(db, 'Edited money entry'); await ch.ready();
  const t = await ch.update('txns', before, patch);
  const L2 = new Ledger(L.raw.clients, L.raw.projects, [t], [], L.raw.invoices);
  return done('Updated the entry.', { entry: L2.txnSummary(L2.txns[0]) }, await ch.commit());
}

async function deleteTransactions(db, a) {
  const ids = [].concat(a.ids || [], a.id || []);
  if (!ids.length) fail('Give the id (or ids) of the entries to delete. Use list_transactions to find them.');
  const L = await load(db);
  const rows = ids.map(id => L.raw.txns.find(t => t.id === id));
  const missing = ids.filter((id, i) => !rows[i]);
  if (missing.length) return { error: 'No money entry has id ' + missing.join(', ') + '.' };
  if (a.confirm !== true) return confirmFirst('deleted', { entries: rows.map(r => L.txnSummary(L.txns.find(t => t.id === r.id))) });
  const ch = new Change(db, 'Deleted ' + rows.length + ' money ' + (rows.length === 1 ? 'entry' : 'entries')); await ch.ready();
  for (const r of rows) await ch.remove('txns', r);
  return done('Deleted ' + rows.length + ' money ' + (rows.length === 1 ? 'entry.' : 'entries.'), {}, await ch.commit());
}

// ---------- milestones ----------
const milestoneName = (i, n) => n === 1 ? 'Full payment' : i === 0 ? 'Advance' : i === n - 1 ? 'Final payment' : 'Payment ' + (i + 1);

// Replaces a project's whole milestone list in one change, from a percentage split of the quote or from a list.
async function setMilestones(db, a) {
  const L = await load(db);
  const r = L.resolveProject(a.project, a.client); if (r.error) return r;
  const p = L.raw.projects.find(x => x.id === r.project.id), quoted = Number(p.quoted) || 0, label = L.projectLabel(r.project);
  if (given(a.split) === given(a.milestones)) fail('Give either a split like [50, 30, 20] or a list of milestones (an empty list removes them all).');
  let list;
  if (given(a.split)) {
    if (!Array.isArray(a.split) || !a.split.length) fail('The split must be a list of percentages, like [50, 30, 20].');
    if (!quoted) fail(label + ' has no quoted price, so it can\'t be split. Set the quote first, or give milestones with amounts.');
    const parts = a.split.map(Number);
    if (parts.some(x => !(x > 0))) fail('Each part of the split must be a percentage above 0.');
    if (Math.abs(parts.reduce((x, y) => x + y, 0) - 100) > 0.01) fail('The split must add up to 100, like [50, 30, 20].');
    const dues = Array.isArray(a.due_dates) ? a.due_dates : [];
    let used = 0;
    // Whole rupees, with the last part taking what's left so the total is exactly the quote.
    list = parts.map((x, i) => { const amount = i === parts.length - 1 ? round(quoted - used) : Math.round(quoted * x / 100); used += amount;
      return { name: milestoneName(i, parts.length), amount, due_date: dues[i] ? date(dues[i], 'Due date ' + (i + 1)) : null }; });
  } else {
    if (!Array.isArray(a.milestones)) fail('milestones must be a list.');
    list = a.milestones.map((m, i, all) => ({ name: text(m && m.name, 200) || milestoneName(i, all.length),
      amount: money(m && m.amount, { label: 'Milestone ' + (i + 1) + ' amount' }), due_date: m && m.due_date ? date(m.due_date, 'Milestone ' + (i + 1) + ' due date') : null }));
  }
  if (list.length > 24) fail('Use at most 24 milestones.');
  if (list.some(m => !(m.amount > 0))) fail('The quote is too small to split that way.');
  const old = L.raw.milestones.filter(m => m.project_id === p.id);
  if (!list.length && !old.length) return { error: label + ' has no milestones to remove.' };
  const total = round(list.reduce((x, m) => x + m.amount, 0));
  const ch = new Change(db, (list.length ? 'Set ' + list.length + ' milestones on ' : 'Removed the milestones from ') + label); await ch.ready();
  for (const i of L.raw.invoices.filter(i => old.some(m => m.id === i.milestone_id))) await ch.update('invoices', i, { milestone_id: null });
  for (const m of old) await ch.remove('milestones', m);
  const rows = list.length ? await ch.insert('milestones', list.map((m, i) => ({ project_id: p.id, name: m.name, amount: m.amount, due_date: m.due_date, sort_order: i }))) : [];
  const now = new Ledger(L.raw.clients, L.raw.projects, L.raw.txns, L.raw.milestones.filter(m => m.project_id !== p.id).concat(rows));
  return done(list.length ? 'Set ' + list.length + ' milestones on ' + label + ', totalling ₹' + total.toLocaleString('en-IN') + '.' : 'Removed the milestones from ' + label + '.',
    { project: label, milestones: now.milestones(now.project(p.id)),
      warning: list.length && quoted && total !== quoted ? 'The milestones add up to ₹' + total.toLocaleString('en-IN') + ', but the quote is ₹' + quoted.toLocaleString('en-IN') + '. Tell the user.' : undefined }, await ch.commit());
}

// ---------- settings ----------
const SETTING_FIELDS = { business_name: 200, address: 1000, phone: 100, email: 200, upi_id: 100, bank_details: 1000, invoice_prefix: 20, invoice_notes: 2000 };
async function getSettings(db) { const L = await load(db); return { settings: L.settings, saved: !!L.raw.settings.length }; }

async function updateSettings(db, a) {
  const L = await load(db), before = L.raw.settings[0], patch = {};
  for (const [k, max] of Object.entries(SETTING_FIELDS)) if (given(a[k])) patch[k] = text(a[k], max);
  if (given(a.upi_id) && patch.upi_id && !/^[\w.\-]{2,256}@[a-z][a-z0-9.\-]{1,64}$/i.test(patch.upi_id)) fail('The UPI ID doesn\'t look right. It looks like name@bank, e.g. yourname@okhdfcbank.');
  if (given(a.invoice_prefix) && !/^[A-Za-z0-9-]{1,10}$/.test(patch.invoice_prefix)) fail('The invoice prefix can only have letters, numbers and dashes (up to 10), like INV.');
  if (given(a.payment_terms_days)) { const n = Number(a.payment_terms_days); if (!Number.isInteger(n) || n < 0 || n > 365) fail('Payment terms must be a whole number of days from 0 to 365.'); patch.payment_terms_days = n; }
  if (!Object.keys(patch).length) fail('Say what to change: ' + Object.keys(SETTING_FIELDS).join(', ') + ' or payment_terms_days.');
  const ch = new Change(db, 'Edited business details'); await ch.ready();
  if (before) await ch.update('settings', before, patch); else await ch.insert('settings', patch);
  const now = await load(db);
  return done('Saved ' + Object.keys(patch).join(', ') + '.', { settings: now.settings }, await ch.commit());
}

// ---------- invoices ----------
function invoiceItems(list) {
  if (!Array.isArray(list) || !list.length) fail('Give at least one line item (description, quantity, rate).');
  if (list.length > 50) fail('Use at most 50 line items.');
  return list.map((it, i) => {
    const description = text(it && it.description, 500); if (!description) fail('Line ' + (i + 1) + ' needs a description.');
    const quantity = it.quantity === undefined || it.quantity === '' ? 1 : Number(it.quantity);
    if (!(quantity > 0) || quantity > 1e6) fail('Line ' + (i + 1) + ': quantity must be above 0.');
    return { description, quantity, rate: money(it.rate, { label: 'Line ' + (i + 1) + ' rate' }) };
  });
}
const itemsTotal = items => round(items.reduce((a, i) => a + i.quantity * i.rate, 0));

async function createInvoice(db, a) {
  const L = await load(db);
  let clientId, projectId = null, milestone = null, items;
  if (text(a.project)) { const r = L.resolveProject(a.project, a.client); if (r.error) return r; clientId = r.project.clientId; projectId = r.project.id; }
  else if (text(a.client)) { const r = L.resolveClient(a.client); if (r.error) return r; clientId = r.client.id; }
  else fail('Say which client (and ideally which project) the invoice is for.');
  if (text(a.milestone)) {
    if (!projectId) fail('Give the project too, to pick its milestone.');
    const p = L.project(projectId), ms = L.milestones(p);
    const q = text(a.milestone).toLowerCase();
    const hits = ms.filter(m => m.id === a.milestone || m.name.toLowerCase() === q);
    if (hits.length !== 1) return { error: hits.length ? 'Several milestones match "' + a.milestone + '".' : 'No milestone on ' + L.projectLabel(p) + ' matches "' + a.milestone + '".', milestones: ms.map(m => m.name) };
    milestone = hits[0];
    if (!milestone.left) return { error: 'The ' + milestone.name + ' milestone is already paid.' };
    const open = L.invoices.find(i => i.milestoneId === milestone.id && L.invoiceState(i).state !== 'cancelled');
    if (open && !a.allow_duplicate) return { error: open.number + ' already invoices this milestone. Use it, cancel it first, or pass allow_duplicate: true.' };
  }
  items = given(a.items) ? invoiceItems(a.items) : milestone ? [{ description: L.project(projectId).title + ' — ' + milestone.name, quantity: 1, rate: milestone.left }] : invoiceItems(a.items);
  const issue = given(a.issue_date) ? date(a.issue_date, 'Issue date') : todayIST();
  if (!issue) fail('The issue date can\'t be empty.');
  const due = given(a.due_date) ? date(a.due_date, 'Due date') : addDays(issue, L.settings.paymentTermsDays);
  if (due && due < issue) fail('The due date can\'t be before the issue date.');
  const number = nextInvoiceNumber(L.invoices.map(i => i.number), L.settings.invoicePrefix, issue);
  const total = itemsTotal(items); if (!(total > 0)) fail('The invoice total must be above ₹0.');
  const ch = new Change(db, 'Created invoice ' + number); await ch.ready();
  const [row] = await ch.insert('invoices', { client_id: clientId, project_id: projectId, milestone_id: milestone ? milestone.id : null, number, issue_date: issue, due_date: due,
    items, total, status: a.mark_sent ? 'sent' : 'draft', notes: given(a.notes) ? text(a.notes, 2000) : L.settings.invoiceNotes, sent_at: a.mark_sent ? new Date().toISOString() : null });
  const now = new Ledger(L.raw.clients, L.raw.projects, L.raw.txns, L.raw.milestones, L.raw.invoices.concat([row]), L.raw.settings);
  return done('Created ' + number + ' for ' + L.clientName(clientId) + ', ₹' + total.toLocaleString('en-IN') + (a.mark_sent ? ', marked as sent.' : ' (draft).'),
    { invoice: now.getInvoice({ invoice: row.id }), setupNeeded: L.settings.upiId && L.settings.businessName ? undefined : 'Business name or UPI ID isn\'t set yet; offer to add them with update_settings so the invoice shows who to pay.' }, await ch.commit());
}

async function updateInvoice(db, a) {
  const L = await load(db);
  const r = L.resolveInvoice(a.invoice); if (r.error) return r;
  const before = L.raw.invoices.find(i => i.id === r.invoice.id), patch = {};
  if (given(a.status)) {
    const s = text(a.status).toLowerCase();
    if (!['draft', 'sent', 'cancelled'].includes(s)) fail('status must be draft, sent or cancelled. Paid is worked out from the payments linked to it.');
    patch.status = s; if (s === 'sent' && !before.sent_at) patch.sent_at = new Date().toISOString();
  }
  if (before.status === 'cancelled' && patch.status !== 'draft' && patch.status !== 'sent') fail(before.number + ' is cancelled. Set status to sent or draft to reopen it first.');
  if (given(a.items)) { patch.items = invoiceItems(a.items); patch.total = itemsTotal(patch.items); if (!(patch.total > 0)) fail('The invoice total must be above ₹0.'); }
  if (given(a.issue_date)) { patch.issue_date = date(a.issue_date, 'Issue date'); if (!patch.issue_date) fail('The issue date can\'t be empty.'); }
  if (given(a.due_date)) patch.due_date = date(a.due_date, 'Due date');
  if (given(a.notes)) patch.notes = text(a.notes, 2000);
  if (!Object.keys(patch).length) fail('Say what to change: status, items, issue_date, due_date or notes.');
  const ch = new Change(db, (patch.status === 'cancelled' ? 'Cancelled invoice ' : 'Edited invoice ') + before.number); await ch.ready();
  const row = await ch.update('invoices', before, patch);
  const now = new Ledger(L.raw.clients, L.raw.projects, L.raw.txns, L.raw.milestones, L.raw.invoices.map(i => i.id === row.id ? row : i), L.raw.settings);
  return done((patch.status === 'cancelled' ? 'Cancelled ' : 'Updated ') + before.number + '.', { invoice: now.getInvoice({ invoice: row.id }) }, await ch.commit());
}

// Records that the user reminded a client (the message itself is sent by the user, never by this server).
async function logReminder(db, a) {
  const L = await load(db);
  const facts = L.reminderFacts(a); if (facts.error) return facts;
  const rows = facts.invoices.map(f => L.raw.invoices.find(i => i.number === f.number));
  const t = todayIST(), ch = new Change(db, 'Logged a reminder to ' + facts.client); await ch.ready();
  for (const r of rows) await ch.update('invoices', r, { last_reminded: t, reminder_count: (r.reminder_count || 0) + 1 });
  return done('Logged a reminder to ' + facts.client + ' for ' + rows.map(r => r.number).join(', ') + '.', {}, await ch.commit());
}

// ---------- renewals ----------
function serviceFields(L, a, partial, clientId) {
  const f = {};
  if (given(a.name)) { f.name = text(a.name, 200); if (!f.name) fail('Give the service a name, like "geekboz.in" or "Hostinger Business".'); }
  if (given(a.kind)) { f.kind = text(a.kind).toLowerCase(); if (!SERVICE_KINDS.includes(f.kind)) fail('kind must be one of: ' + SERVICE_KINDS.join(', ') + '.'); }
  if (given(a.provider)) f.provider = text(a.provider, 200);
  if (given(a.cost)) f.cost = money(a.cost, { allowZero: true, label: 'Cost' });
  if (given(a.price)) f.price = money(a.price, { allowZero: true, label: 'Price' });
  if (given(a.cycle)) { f.cycle = text(a.cycle).toLowerCase(); if (!CYCLE_MONTHS[f.cycle]) fail('cycle must be monthly, quarterly or yearly.'); }
  if (given(a.next_renewal)) { f.next_renewal = date(a.next_renewal, 'Next renewal'); if (!f.next_renewal) fail('The next renewal date can\'t be empty.'); }
  if (given(a.auto_renew)) f.auto_renew = a.auto_renew === true;
  if (given(a.active)) f.active = a.active !== false;
  if (given(a.notes)) f.notes = text(a.notes, 2000);
  if (given(a.project)) {
    if (!a.project) f.project_id = null;
    else { const r = L.resolveProject(a.project); if (r.error) fail(r.error); if (clientId && r.project.clientId !== clientId) fail('That project belongs to a different client.'); f.project_id = r.project.id; }
  }
  if (!partial) { f.name || fail('Give the service a name, like "geekboz.in" or "Hostinger Business".'); f.next_renewal || fail('Say when it next renews (next_renewal, YYYY-MM-DD).'); }
  return f;
}

async function addService(db, a) {
  const L = await load(db);
  let clientId;
  if (text(a.project) && !text(a.client)) { const r = L.resolveProject(a.project); if (r.error) return r; clientId = r.project.clientId; }
  else { const r = L.resolveClient(a.client); if (r.error) return r; clientId = r.client.id; }
  const f = serviceFields(L, a, false, clientId);
  const ch = new Change(db, 'Added service ' + f.name); await ch.ready();
  const [row] = await ch.insert('services', { client_id: clientId, project_id: f.project_id ?? null, kind: f.kind || 'other', name: f.name, provider: f.provider || '',
    cost: f.cost || 0, price: f.price || 0, cycle: f.cycle || 'yearly', next_renewal: f.next_renewal, auto_renew: !!f.auto_renew, active: f.active !== false, notes: f.notes || '' });
  const now = new Ledger(L.raw.clients, L.raw.projects, L.raw.txns, [], [], [], [row]);
  return done('Added ' + row.name + ' for ' + L.clientName(clientId) + ', renewing ' + niceDate(row.next_renewal) + '.', { service: now.serviceSummary(now.services[0]) }, await ch.commit());
}

async function updateService(db, a) {
  const L = await load(db);
  const r = L.resolveService(a.service, a.client); if (r.error) return r;
  const before = L.raw.services.find(x => x.id === r.service.id);
  const patch = serviceFields(L, a, true, before.client_id);
  if (!Object.keys(patch).length) fail('Say what to change on the service.');
  const ch = new Change(db, 'Edited service ' + before.name); await ch.ready();
  const row = await ch.update('services', before, patch);
  const now = new Ledger(L.raw.clients, L.raw.projects, L.raw.txns, [], [], [], [row]);
  return done('Updated ' + row.name + ' (' + Object.keys(patch).join(', ') + ').', { service: now.serviceSummary(now.services[0]) }, await ch.commit());
}

// One renewal, as one change so a single undo reverses it all: log what it cost you, invoice the client,
// and move the renewal date forward one cycle. Shows what it will do first.
async function renewService(db, a) {
  const L = await load(db);
  const r = L.resolveService(a.service, a.client); if (r.error) return r;
  const svc = r.service, row = L.raw.services.find(x => x.id === svc.id);
  if (!svc.active) return { error: svc.name + ' is inactive. Set active: true with update_service first.' };
  const t = todayIST(), next = addMonths(svc.nextRenewal, CYCLE_MONTHS[svc.cycle]), client = L.clientName(svc.clientId);
  const expense = a.log_expense !== false && svc.cost > 0, invoice = a.create_invoice !== false && svc.price > 0;
  const number = invoice ? nextInvoiceNumber(L.invoices.map(i => i.number), L.settings.invoicePrefix, t) : null;
  const period = niceDate(svc.nextRenewal) + ' to ' + niceDate(addDays(next, -1));
  const steps = [
    expense ? 'Log ₹' + svc.cost.toLocaleString('en-IN') + ' spent on ' + svc.name + ' (' + KIND_CATEGORY[svc.kind] + ').' : null,
    invoice ? 'Create draft invoice ' + number + ' to ' + client + ' for ₹' + svc.price.toLocaleString('en-IN') + '.' : null,
    'Move the next renewal from ' + niceDate(svc.nextRenewal) + ' to ' + niceDate(next) + '.'].filter(Boolean);
  if (a.confirm !== true) return { confirmation_required: true, message: 'Nothing has been changed yet. Show the user these steps, and call again with confirm: true only after they agree.', service: svc.name, client, steps };
  const ch = new Change(db, 'Renewed ' + svc.name + ' for ' + client); await ch.ready();
  if (expense) await ch.insert('txns', { client_id: svc.clientId, project_id: svc.projectId, type: 'out', amount: svc.cost, category: KIND_CATEGORY[svc.kind], note: svc.name + ' renewal', date: t });
  let inv = null;
  if (invoice) [inv] = await ch.insert('invoices', { client_id: svc.clientId, project_id: svc.projectId, milestone_id: null, number, issue_date: t, due_date: addDays(t, L.settings.paymentTermsDays),
    items: [{ description: svc.name + ' — ' + svc.kind + ' renewal (' + period + ')', quantity: 1, rate: svc.price }], total: svc.price, status: 'draft', notes: L.settings.invoiceNotes, sent_at: null });
  await ch.update('services', row, { next_renewal: next });
  return done('Renewed ' + svc.name + ': ' + steps.join(' '), { invoice: inv ? inv.number : undefined, nextRenewal: next }, await ch.commit());
}

// ---------- history and undo ----------
// ---------- tasks and time ----------
// Tasks sort by due date and then the order they were added; sort_order keeps that order for tasks with no date.
async function addTasks(db, a) {
  const L = await load(db);
  const r = L.resolveProject(a.project, a.client); if (r.error) return r;
  if (!Array.isArray(a.tasks) || !a.tasks.length) fail('Give at least one task, like ["Design homepage", "Set up hosting"].');
  if (a.tasks.length > 50) fail('Add at most 50 tasks at a time.');
  const label = L.projectLabel(r.project), start = L.tasks.filter(t => t.projectId === r.project.id).length;
  const rows = a.tasks.map((t, i) => {
    const o = typeof t === 'string' ? { title: t } : (t || {}), title = text(o.title, 300);
    if (!title) fail('Task ' + (i + 1) + ' needs a title.');
    return { project_id: r.project.id, title, due_date: o.due_date ? date(o.due_date, 'Task ' + (i + 1) + ' due date') : null, sort_order: start + i };
  });
  const ch = new Change(db, 'Added ' + rows.length + (rows.length === 1 ? ' task to ' : ' tasks to ') + label); await ch.ready();
  const out = await ch.insert('tasks', rows);
  const L2 = new Ledger(L.raw.clients, L.raw.projects, [], [], [], [], [], out);
  return done('Added ' + rows.length + (rows.length === 1 ? ' task' : ' tasks') + ' to ' + label + '.', { tasks: out.map(t => L2.taskSummary(L2.tasks.find(x => x.id === t.id))) }, await ch.commit());
}

async function updateTask(db, a) {
  const L = await load(db);
  const r = L.resolveTask(a.task, a.project, a.client); if (r.error) return r;
  const before = L.raw.tasks.find(t => t.id === r.task.id), patch = {};
  if (given(a.title)) { patch.title = text(a.title, 300); if (!patch.title) fail('The task title can\'t be empty.'); }
  if (given(a.due_date)) patch.due_date = date(a.due_date, 'Due date');
  if (given(a.done)) {
    if (typeof a.done !== 'boolean') fail('done must be true or false.');
    if (a.done !== !!before.done) { patch.done = a.done; patch.done_at = a.done ? new Date().toISOString() : null; }
  }
  if (!Object.keys(patch).length) fail('Say what to change on the task: title, done or due_date.');
  const ch = new Change(db, (patch.done === true ? 'Completed task ' : 'Edited task ') + before.title); await ch.ready();
  const row = await ch.update('tasks', before, patch);
  const L2 = new Ledger(L.raw.clients, L.raw.projects, [], [], [], [], [], [row]);
  return done((patch.done === true ? 'Marked done: ' : 'Updated: ') + row.title + '.', { task: L2.taskSummary(L2.tasks[0]) }, await ch.commit());
}

async function deleteTask(db, a) {
  const L = await load(db);
  const r = L.resolveTask(a.task, a.project, a.client); if (r.error) return r;
  const t = L.raw.tasks.find(x => x.id === r.task.id), sum = L.taskSummary(r.task);
  if (a.confirm !== true) return confirmFirst('deleted', { task: sum });
  const ch = new Change(db, 'Deleted task ' + t.title); await ch.ready();
  await ch.remove('tasks', t);
  return done('Deleted the task "' + t.title + '".', {}, await ch.commit());
}

// Time is logged in minutes; hours are accepted and turned into minutes (1.5 hours = 90).
async function logTime(db, a) {
  const L = await load(db);
  const r = L.resolveProject(a.project, a.client); if (r.error) return r;
  if (given(a.minutes) === given(a.hours)) fail('Give the time as either minutes or hours.');
  const minutes = given(a.minutes) ? Number(a.minutes) : Math.round(Number(a.hours) * 60);
  if (!Number.isInteger(minutes) || minutes <= 0) fail('The time must be a whole number of minutes above 0 (or hours that come to at least a minute).');
  if (minutes > 1440) fail('One entry can be at most 24 hours. Split longer work across days.');
  const label = L.projectLabel(r.project), d = a.date === undefined ? todayIST() : date(a.date, 'Date');
  if (!d) fail('The date can\'t be empty.');
  const ch = new Change(db, 'Logged ' + niceDuration(minutes) + ' on ' + label); await ch.ready();
  const [row] = await ch.insert('time_entries', { project_id: r.project.id, date: d, minutes, note: text(a.note, 500) });
  const L2 = new Ledger(L.raw.clients, L.raw.projects, L.raw.txns, [], [], [], [], L.raw.tasks, [...L.raw.time_entries, row]);
  return done('Logged ' + niceDuration(minutes) + ' on ' + label + '.', { entry: L2.timeSummary(L2.timeEntries.find(e => e.id === row.id)), projectTime: L2.projectTime(L2.project(r.project.id)) }, await ch.commit());
}
const niceDuration = m => (m >= 60 ? Math.floor(m / 60) + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '') : m + 'm');

async function listChanges(db, a) {
  const rows = await db.select('activity_log');
  const batches = {};
  rows.forEach(r => { const b = batches[r.batch_id] = batches[r.batch_id] || { change_id: r.batch_id, when: r.created_at, summary: r.summary, undone: !!r.undone_at, rowsChanged: 0 }; b.rowsChanged++; if (r.created_at < b.when) b.when = r.created_at; });
  const list = Object.values(batches).sort((x, y) => y.when.localeCompare(x.when));
  const n = Math.max(1, Math.min(100, Number(a.limit) || 20));
  return { count: list.length, changes: list.slice(0, n) };
}

async function undoChange(db, a) {
  const all = await db.select('activity_log');
  let batch = a.change_id;
  if (!batch) {
    const open = all.filter(r => !r.undone_at).sort((x, y) => y.created_at.localeCompare(x.created_at));
    if (!open.length) return { error: 'There are no changes left to undo.' };
    batch = open[0].batch_id;
  }
  const entries = all.filter(r => r.batch_id === batch).sort((x, y) => y.seq - x.seq);
  if (!entries.length) return { error: 'No change has id ' + batch + '. Use list_recent_changes to see them.' };
  if (entries[0].undone_at) return { error: 'That change was already undone.' };
  const L = await load(db);
  const insertedHere = new Set(entries.filter(e => e.op === 'insert').map(e => e.row_id));
  // Undoing an insert deletes the row; refuse if something added later depends on it.
  for (const e of entries.filter(e => e.op === 'insert')) {
    const deps = e.table_name === 'clients' ? [...L.raw.projects.filter(p => p.client_id === e.row_id), ...L.raw.txns.filter(t => t.client_id === e.row_id), ...L.raw.invoices.filter(i => i.client_id === e.row_id), ...L.raw.services.filter(x => x.client_id === e.row_id)]
      : e.table_name === 'projects' ? [...L.raw.txns.filter(t => t.project_id === e.row_id), ...L.raw.milestones.filter(m => m.project_id === e.row_id), ...L.raw.invoices.filter(i => i.project_id === e.row_id), ...L.raw.services.filter(x => x.project_id === e.row_id), ...L.raw.tasks.filter(t => t.project_id === e.row_id), ...L.raw.time_entries.filter(x => x.project_id === e.row_id)]
      : e.table_name === 'milestones' ? L.raw.invoices.filter(i => i.milestone_id === e.row_id)
      : e.table_name === 'invoices' ? L.raw.txns.filter(t => t.invoice_id === e.row_id) : [];
    const later = deps.filter(d => !insertedHere.has(d.id));
    if (later.length) return { error: 'Can\'t undo "' + e.summary + '": ' + later.length + ' newer item(s) were added to what it created. Undo or move those first.' };
  }
  const current = { clients: L.raw.clients, projects: L.raw.projects, txns: L.raw.txns, milestones: L.raw.milestones, settings: L.raw.settings, invoices: L.raw.invoices, services: L.raw.services, tasks: L.raw.tasks, time_entries: L.raw.time_entries };
  const skipped = [];
  for (const e of entries) {
    const exists = current[e.table_name].some(r => r.id === e.row_id);
    if (e.op === 'insert') { if (exists) await db.remove(e.table_name, e.row_id); else skipped.push('an added ' + e.table_name.replace(/s$/, '') + ' was already gone'); }
    else if (e.op === 'update') { if (exists) await db.update(e.table_name, e.row_id, e.before); else skipped.push('an edited ' + e.table_name.replace(/s$/, '') + ' no longer exists'); }
    else if (e.op === 'delete') { if (!exists) { const { user_id, ...row } = e.before; await db.insert(e.table_name, row); current[e.table_name] = current[e.table_name].concat([{ id: e.row_id }]); } }
  }
  await db.updateWhere('activity_log', { batch_id: batch }, { undone_at: new Date().toISOString() });
  return { done: true, message: 'Undid: ' + entries[0].summary + '.', change_id: batch, skipped: skipped.length ? skipped : undefined };
}

module.exports = { createClient, updateClient, deleteClient, createProject, updateProject, deleteProject, setMilestones, addTransactions, updateTransaction, deleteTransactions,
  getSettings, updateSettings, createInvoice, updateInvoice, logReminder, addService, updateService, renewService, addTasks, updateTask, deleteTask, logTime, listChanges, undoChange, Invalid };
