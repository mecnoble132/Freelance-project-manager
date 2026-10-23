// The MCP tools: what the assistant sees (name, description, input schema) and what each one runs.
const { load, PERIODS, CATEGORIES } = require('./ledger');
const W = require('./writes');

const period = { type: 'string', enum: PERIODS, description: 'Time period. Defaults to all_time. this_fy / last_fy are Indian financial years (April to March). Ignored when from or to is given.' };
const day = d => ({ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: d + ' (YYYY-MM-DD).' });
const str = d => ({ type: 'string', description: d });
const obj = (properties, required) => ({ type: 'object', properties, ...(required ? { required } : {}), additionalProperties: false });
const confirm = { type: 'boolean', description: 'Leave out first: the tool then only shows what would be deleted. Pass true only after the user has seen that and agreed.' };
const statusIn = { type: 'string', enum: ['lead', 'active', 'paused', 'done'], description: 'lead, active (in progress), paused (on hold) or done.' };
const projectRef = { project: str('Project id, title, or "client title" like "GeekBoz Website".'), client: str('Client name, to pick between projects with the same title.') };
const projectFieldSchema = {
  status: statusIn,
  quoted: { type: 'number', minimum: 0, description: 'Agreed price in rupees.' },
  start_date: str('Start date (YYYY-MM-DD). Empty string clears it.'),
  due_date: str('Due date (YYYY-MM-DD). Empty string clears it.'),
  preview_url: str('Preview / staging link. Empty string clears it.'),
  live_url: str('Live site link. Empty string clears it.'),
  github_url: str('GitHub repository or project board link. Empty string clears it.'),
  description: str('What the project is: scope, tech stack, notes.')
};
const entrySchema = {
  amount: { type: 'number', minimum: 0.01, description: 'Amount in rupees.' },
  client: str('Client name or id. Not needed when project is given and unambiguous.'),
  project: str('Project title (or "client title"). Leave out for money not tied to a project.'),
  date: day('Date the money moved. Defaults to today (India time)'),
  note: str('What it was for, e.g. "Advance", "Final payment", ".com renewal".')
};

const RO = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const EDIT = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
const DELETE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

const read = fn => async (db, a) => fn(await load(db), a);

const TOOLS = [
  // ---------- read ----------
  { name: 'get_summary', title: 'Business summary', annotations: RO,
    description: 'Revenue, spending, profit and margin for a period, plus money still to collect, projects by status, month-by-month totals, spending by category and the most profitable projects. Start here for questions about how the business is doing.',
    inputSchema: obj({ period, from: day('Start date, inclusive'), to: day('End date, inclusive') }),
    run: read((l, a) => l.summary(a)) },
  { name: 'compare_periods', title: 'Compare two periods', annotations: RO,
    description: 'Revenue, spending and profit for two periods side by side, with the change. Defaults to this month vs last month.',
    inputSchema: obj({ preset: { type: 'string', enum: ['month_vs_last_month', 'fy_vs_last_fy', 'year_vs_last_year', 'last_12_vs_previous_12'], description: 'fy_vs_last_fy = this financial year (April to March) vs the last one.' },
      a_from: day('Current period start'), a_to: day('Current period end'), b_from: day('Previous period start'), b_to: day('Previous period end') }),
    run: read((l, a) => l.comparePeriods(a)) },
  { name: 'get_attention_items', title: 'What needs attention', annotations: RO,
    description: 'Overdue projects, projects due within a week, money still to collect (with the last payment date), open leads, projects on hold, and missing information like projects without a quoted price.',
    inputSchema: obj({}), run: read(l => l.attention()) },
  { name: 'search', title: 'Search everything', annotations: RO,
    description: 'Finds clients, projects and money entries whose names, notes, descriptions, contacts or links contain the text.',
    inputSchema: obj({ query: str('Text to look for.') }, ['query']), run: read((l, a) => l.search(a)) },
  { name: 'list_projects', title: 'List projects', annotations: RO,
    description: 'Every project with id, client, status, description, preview/live/GitHub links, dates and money (quoted, received, spent, profit, still to collect). Filter by status, client or text.',
    inputSchema: obj({ status: { type: 'string', enum: ['lead', 'active', 'paused', 'done', 'open'], description: 'open = anything not done.' }, client: str('Client name, or part of it.'), search: str('Text in the title, client or description.') }),
    run: read((l, a) => l.listProjects(a)) },
  { name: 'get_project', title: 'Project details', annotations: RO,
    description: 'Everything about one project, including every payment and expense on it (with their ids).',
    inputSchema: obj(projectRef, ['project']), run: read((l, a) => l.getProject(a)) },
  { name: 'list_clients', title: 'List clients', annotations: RO,
    description: 'Every client with id, number of projects, revenue, spending, profit and money still to collect.',
    inputSchema: obj({}), run: read(l => l.listClients()) },
  { name: 'get_client', title: 'Client details', annotations: RO,
    description: 'One client with contact, notes, totals, their projects and every payment and expense (with ids).',
    inputSchema: obj({ client: str('Client id or name.') }, ['client']), run: read((l, a) => l.getClient(a)) },
  { name: 'list_transactions', title: 'List payments and expenses', annotations: RO,
    description: 'Payments (money in) and expenses (money out) with their ids, newest first, with totals for what matched. Filter by type, period or dates, client, project and expense category.',
    inputSchema: obj({ type: { type: 'string', enum: ['in', 'out'], description: 'in = payments, out = expenses.' }, period, from: day('Start date, inclusive'), to: day('End date, inclusive'),
      client: str('Client name, or part of it.'), project: str('Project title, or part of it.'), category: { type: 'string', enum: CATEGORIES },
      limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Defaults to 100.' } }),
    run: read((l, a) => l.listTransactions(a)) },
  { name: 'list_recent_changes', title: 'Recent changes', annotations: RO,
    description: 'Changes made through this assistant connection, newest first, with their change_id and whether they were undone.',
    inputSchema: obj({ limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Defaults to 20.' } }), run: W.listChanges },

  // ---------- clients ----------
  { name: 'create_client', title: 'Add a client', annotations: WRITE,
    description: 'Adds a client. Refuses if a client with the same name exists, unless allow_duplicate is true.',
    inputSchema: obj({ name: str('Client or business name.'), contact: str('Phone or email.'), notes: str('Anything to remember about them.'), allow_duplicate: { type: 'boolean' } }, ['name']),
    run: W.createClient },
  { name: 'update_client', title: 'Edit a client', annotations: EDIT,
    description: 'Changes a client\'s name, contact or notes. Only the fields given are changed.',
    inputSchema: obj({ client: str('Client id or current name.'), name: str('New name.'), contact: str('New phone or email.'), notes: str('New notes (replaces the old ones).') }, ['client']),
    run: W.updateClient },
  { name: 'delete_client', title: 'Delete a client', annotations: DELETE,
    description: 'Deletes a client together with all their projects and money entries. First call without confirm to see what would be deleted.',
    inputSchema: obj({ client: str('Client id or name.'), confirm }, ['client']), run: W.deleteClient },

  // ---------- projects ----------
  { name: 'create_project', title: 'Add a project', annotations: WRITE,
    description: 'Adds a project for a client. If the client doesn\'t exist yet, the tool says so: confirm the spelling with the user, then call again with new_client: true to create the client too.',
    inputSchema: obj({ title: str('Project title, e.g. "Website", "Booking system".'), client: str('Client name or id.'), new_client: { type: 'boolean', description: 'Create the client if no client matches.' },
      client_contact: str('Contact for a new client.'), ...projectFieldSchema, allow_duplicate: { type: 'boolean' } }, ['title', 'client']),
    run: W.createProject },
  { name: 'update_project', title: 'Edit a project', annotations: EDIT,
    description: 'Changes any project fields: title, status, quoted price, dates, links, description, or moves it to another client (its money moves with it). Only the fields given are changed.',
    inputSchema: obj({ ...projectRef, title: str('New title.'), move_to_client: str('Client to move the project to.'), ...projectFieldSchema }, ['project']),
    run: W.updateProject },
  { name: 'delete_project', title: 'Delete a project', annotations: DELETE,
    description: 'Deletes a project. Its money entries stay with the client under "No project", unless delete_transactions is true. First call without confirm to see what would be deleted.',
    inputSchema: obj({ ...projectRef, delete_transactions: { type: 'boolean' }, confirm }, ['project']), run: W.deleteProject },

  // ---------- money ----------
  { name: 'add_payment', title: 'Log a payment received', annotations: WRITE,
    description: 'Records money received from a client.',
    inputSchema: obj(entrySchema, ['amount']), run: (db, a) => W.addTransactions(db, [{ ...a, type: 'in' }], 'Logged a payment') },
  { name: 'add_expense', title: 'Log an expense', annotations: WRITE,
    description: 'Records money spent on a client or project, like a domain, hosting or a contractor.',
    inputSchema: obj({ ...entrySchema, category: { type: 'string', enum: CATEGORIES, description: 'Defaults to a category matching the note, else Other.' } }, ['amount']),
    run: (db, a) => W.addTransactions(db, [{ ...a, type: 'out' }], 'Logged an expense') },
  { name: 'add_transactions', title: 'Log several payments or expenses', annotations: WRITE,
    description: 'Records many payments and expenses at once, e.g. from a pasted list or statement. All are checked first; if any can\'t be matched to a client or project, nothing is saved.',
    inputSchema: obj({ entries: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'object', additionalProperties: false, required: ['type', 'amount'],
      properties: { type: { type: 'string', enum: ['in', 'out'] }, ...entrySchema, category: { type: 'string', enum: CATEGORIES } } } } }, ['entries']),
    run: (db, a) => W.addTransactions(db, a.entries) },
  { name: 'update_transaction', title: 'Edit a payment or expense', annotations: EDIT,
    description: 'Changes a money entry by id: amount, date, note, type, category, or which client/project it belongs to. Pass project as an empty string to detach it from its project.',
    inputSchema: obj({ id: str('Entry id, from list_transactions or get_project.'), type: { type: 'string', enum: ['in', 'out'] }, amount: entrySchema.amount,
      date: str('Date (YYYY-MM-DD). Empty string clears it.'), note: str('New note.'), category: { type: 'string', enum: CATEGORIES }, client: entrySchema.client, project: entrySchema.project }, ['id']),
    run: W.updateTransaction },
  { name: 'delete_transactions', title: 'Delete payments or expenses', annotations: DELETE,
    description: 'Deletes one or more money entries by id. First call without confirm to see what would be deleted.',
    inputSchema: obj({ ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 200 }, confirm }, ['ids']), run: W.deleteTransactions },

  // ---------- undo ----------
  { name: 'undo_change', title: 'Undo a change', annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    description: 'Reverts one change made through this connection: the latest one by default, or the one with the given change_id. A change made by one tool call is undone as a whole.',
    inputSchema: obj({ change_id: str('From a tool result or list_recent_changes. Leave out to undo the latest change.') }), run: W.undoChange }
];

const INSTRUCTIONS = `Client Ledger: a freelance web developer's clients, web projects (status, description, preview/live/GitHub links, quoted price, dates) and every payment and expense. All money is in Indian rupees (INR); dates are YYYY-MM-DD in India time.
Reading: "still to collect" is quoted price minus money received, for projects that aren't leads. Some older entries have no date; they only count under all_time.
The financial year runs April to March (FY 2026–27 is 2026-04-01 to 2027-03-31). When the user says "this year" about money, taxes or how the business did, they usually mean the financial year: use this_fy / last_fy, and say which you used.
Changing data:
- Before creating or changing anything, make sure you have the details right. If the user's message was vague, sum up what you're about to save and ask first.
- Several projects can share a title (many are called "Website"), so name the client too.
- If a client isn't found, don't guess: check the spelling with the user before creating a new one (create_project with new_client: true).
- Deletes are two-step: call without confirm to get a preview, show it to the user, and only call again with confirm: true after they agree.
- Every change returns a change_id. Tell the user what was saved; undo_change reverts it. Changes show up on the website the next time it's loaded.`;

module.exports = { TOOLS, INSTRUCTIONS };
