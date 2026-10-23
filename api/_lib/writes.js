// Changes made through the MCP server. Each tool call is one "change": every row it inserts, updates or deletes
// is recorded in activity_log under one batch id, so the whole call can be listed and undone.
const crypto = require('crypto');
const { load, Ledger, CATEGORIES, STATUSES, todayIST, guessCategory } = require('./ledger');

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
  if (a.confirm !== true) return confirmFirst('deleted', { client: c.name, projects: projects.map(p => p.name), transactions: txns.length,
    moneyIn: txns.filter(t => t.type !== 'out').reduce((s, t) => s + Number(t.amount), 0), moneyOut: txns.filter(t => t.type === 'out').reduce((s, t) => s + Number(t.amount), 0) });
  const ch = new Change(db, 'Deleted client ' + c.name + ' with ' + projects.length + ' projects and ' + txns.length + ' entries'); await ch.ready();
  for (const t of txns) await ch.remove('txns', t);
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
  const now = new Ledger(L.raw.clients, L.raw.projects.map(x => x.id === p.id ? p : x), L.raw.txns);
  return done('Updated "' + p.name + '" (' + Object.keys(patch).map(k => ({ name: 'title', client_id: 'client' })[k] || k).join(', ') + ').', { project: now.projectSummary(now.project(p.id)) }, await ch.commit());
}

async function deleteProject(db, a) {
  const L = await load(db);
  const r = L.resolveProject(a.project, a.client); if (r.error) return r;
  const p = L.raw.projects.find(x => x.id === r.project.id), txns = L.raw.txns.filter(t => t.project_id === p.id);
  const label = p.name + ' (' + L.clientName(p.client_id) + ')';
  if (a.confirm !== true) return confirmFirst('deleted', { project: label, transactions: txns.length,
    whatHappensToMoney: txns.length ? (a.delete_transactions ? 'Its ' + txns.length + ' money entries will be deleted too.' : 'Its ' + txns.length + ' money entries stay with the client under "No project". Pass delete_transactions: true to delete them instead.') : 'It has no money entries.' });
  const ch = new Change(db, 'Deleted project ' + label); await ch.ready();
  for (const t of txns) { if (a.delete_transactions) await ch.remove('txns', t); else await ch.update('txns', t, { project_id: null }); }
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
  const place = placeEntry(L, e);
  if (place.error) return { ...place, error: where + place.error, error_only: true };
  const note = text(e.note, 500);
  return { row: { client_id: place.client_id, project_id: place.project_id, type, amount: money(e.amount, { label: where + 'Amount' }),
    category: type === 'out' ? category(e.category, note) : '', note, date: e.date === undefined ? todayIST() : date(e.date, where + 'Date') }, label: place.label };
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
  const L2 = new Ledger(L.raw.clients, L.raw.projects, rows);
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
  if (given(a.project) || given(a.client)) {
    if (given(a.project) && !a.project) { patch.project_id = null; if (a.client) { const c = L.resolveClient(a.client); if (c.error) return c; patch.client_id = c.client.id; } }
    else { const place = placeEntry(L, { project: a.project, client: a.client }); if (place.error) return place; patch.client_id = place.client_id; patch.project_id = place.project_id; }
  }
  if (!Object.keys(patch).length) fail('Say what to change on the entry.');
  const ch = new Change(db, 'Edited money entry'); await ch.ready();
  const t = await ch.update('txns', before, patch);
  const L2 = new Ledger(L.raw.clients, L.raw.projects, [t]);
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

// ---------- history and undo ----------
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
    const deps = e.table_name === 'clients' ? [...L.raw.projects.filter(p => p.client_id === e.row_id), ...L.raw.txns.filter(t => t.client_id === e.row_id)]
      : e.table_name === 'projects' ? L.raw.txns.filter(t => t.project_id === e.row_id) : [];
    const later = deps.filter(d => !insertedHere.has(d.id));
    if (later.length) return { error: 'Can\'t undo "' + e.summary + '": ' + later.length + ' newer item(s) were added to what it created. Undo or move those first.' };
  }
  const current = { clients: L.raw.clients, projects: L.raw.projects, txns: L.raw.txns };
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

module.exports = { createClient, updateClient, deleteClient, createProject, updateProject, deleteProject, addTransactions, updateTransaction, deleteTransactions, listChanges, undoChange, Invalid };
