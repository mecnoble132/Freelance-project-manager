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
    description: 'Overdue projects, projects due within a week, overdue and soon-due payment milestones, money still to collect (with the last payment date), open leads, projects on hold, and missing information like projects without a quoted price.',
    inputSchema: obj({}), run: read(l => l.attention()) },
  { name: 'search', title: 'Search everything', annotations: RO,
    description: 'Finds clients, projects and money entries whose names, notes, descriptions, contacts or links contain the text.',
    inputSchema: obj({ query: str('Text to look for.') }, ['query']), run: read((l, a) => l.search(a)) },
  { name: 'list_projects', title: 'List projects', annotations: RO,
    description: 'Every project with id, client, status, description, preview/live/GitHub links, dates and money (quoted, received, spent, profit, still to collect). Filter by status, client or text.',
    inputSchema: obj({ status: { type: 'string', enum: ['lead', 'active', 'paused', 'done', 'open'], description: 'open = anything not done.' }, client: str('Client name, or part of it.'), search: str('Text in the title, client or description.') }),
    run: read((l, a) => l.listProjects(a)) },
  { name: 'get_project', title: 'Project details', annotations: RO,
    description: 'Everything about one project, including its payment milestones (paid, part-paid, overdue or unpaid) and every payment and expense on it (with their ids).',
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
  { name: 'set_milestones', title: 'Set payment milestones', annotations: EDIT,
    description: 'Replaces a project\'s payment milestones (the stages its price is paid in) with a new list, in one change. Give a split of the quoted price in percent, like [50, 50] or [50, 30, 20], or a list of milestones with amounts. An empty list removes them all. The project\'s payments cover the milestones in order.',
    inputSchema: obj({ ...projectRef,
      split: { type: 'array', items: { type: 'number', exclusiveMinimum: 0 }, description: 'Percentages of the quoted price that add up to 100, e.g. [50, 30, 20]. Named Advance, Payment 2, ..., Final payment.' },
      due_dates: { type: 'array', items: { type: 'string' }, description: 'With split: due dates (YYYY-MM-DD) for each part, in order. Optional.' },
      milestones: { type: 'array', items: obj({ name: str('e.g. "Advance", "Design approved", "Launch".'), amount: { type: 'number', minimum: 0.01, description: 'Amount in rupees.' }, due_date: day('Due date') }, ['amount']),
        description: 'Instead of split: the milestones in the order they are paid.' } }, ['project']),
    run: W.setMilestones },

  // ---------- money ----------
  { name: 'add_payment', title: 'Log a payment received', annotations: WRITE,
    description: 'Records money received from a client. Pass invoice when it pays an invoice: the client and project then come from the invoice, and the invoice counts as paid once its payments reach its total.',
    inputSchema: obj({ ...entrySchema, invoice: str('Invoice number (or its last part, like "001") this payment is for.') }, ['amount']), run: (db, a) => W.addTransactions(db, [{ ...a, type: 'in' }], 'Logged a payment') },
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
      date: str('Date (YYYY-MM-DD). Empty string clears it.'), note: str('New note.'), category: { type: 'string', enum: CATEGORIES }, client: entrySchema.client, project: entrySchema.project,
      invoice: str('Invoice number this payment is for. Empty string unlinks it, which reopens the invoice.') }, ['id']),
    run: W.updateTransaction },
  { name: 'delete_transactions', title: 'Delete payments or expenses', annotations: DELETE,
    description: 'Deletes one or more money entries by id. First call without confirm to see what would be deleted.',
    inputSchema: obj({ ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 200 }, confirm }, ['ids']), run: W.deleteTransactions },

  // ---------- invoices ----------
  { name: 'get_settings', title: 'Business details', annotations: RO,
    description: 'The business details printed on invoices (name, address, phone, email, UPI ID, bank details), the invoice number prefix, payment terms in days and default invoice notes.',
    inputSchema: obj({}), run: W.getSettings },
  { name: 'update_settings', title: 'Edit business details', annotations: EDIT,
    description: 'Changes the business details printed on invoices. Only the fields given are changed.',
    inputSchema: obj({ business_name: str('Name shown at the top of invoices.'), address: str('Postal address.'), phone: str('Phone.'), email: str('Email.'),
      upi_id: str('UPI ID clients pay to, like name@okhdfcbank. Used for the QR code.'), bank_details: str('Account name, number, IFSC and bank, for bank transfers.'),
      invoice_prefix: str('Start of invoice numbers, like INV (INV/2026-27/001).'), payment_terms_days: { type: 'integer', minimum: 0, maximum: 365, description: 'Days until an invoice is due.' },
      invoice_notes: str('Default notes printed on new invoices.') }),
    run: W.updateSettings },
  { name: 'create_invoice', title: 'Create an invoice', annotations: WRITE,
    description: 'Creates an invoice for a client, numbered automatically (INV/2026-27/001, restarting each financial year). Either invoice a project milestone (its unpaid amount) or give line items. It starts as a draft unless mark_sent is true. No tax is added.',
    inputSchema: obj({ client: entrySchema.client, project: str('Project title (or "client title").'), milestone: str('Milestone name on the project, to invoice what is left of it.'),
      items: { type: 'array', minItems: 1, maxItems: 50, items: obj({ description: str('What the line is for.'), quantity: { type: 'number', exclusiveMinimum: 0, description: 'Defaults to 1.' }, rate: { type: 'number', minimum: 0.01, description: 'Price per unit in rupees.' } }, ['description', 'rate']),
        description: 'Line items. Not needed when invoicing a milestone.' },
      issue_date: day('Issue date. Defaults to today'), due_date: day('Due date. Defaults to the issue date plus the payment terms'), notes: str('Notes printed on the invoice. Defaults to the settings.'),
      mark_sent: { type: 'boolean', description: 'True if the user has already sent it to the client.' }, allow_duplicate: { type: 'boolean', description: 'Allow a second open invoice for the same milestone.' } }),
    run: W.createInvoice },
  { name: 'update_invoice', title: 'Edit, send or cancel an invoice', annotations: EDIT,
    description: 'Marks an invoice as sent, cancels it, or changes its line items, dates or notes. Invoices are never deleted, and their numbers never change or get reused: cancel instead.',
    inputSchema: obj({ invoice: str('Invoice number or its last part, like "001".'), status: { type: 'string', enum: ['draft', 'sent', 'cancelled'] },
      items: { type: 'array', minItems: 1, maxItems: 50, items: obj({ description: str('What the line is for.'), quantity: { type: 'number', exclusiveMinimum: 0 }, rate: { type: 'number', minimum: 0.01 } }, ['description', 'rate']) },
      issue_date: day('Issue date'), due_date: str('Due date (YYYY-MM-DD). Empty string clears it.'), notes: str('Notes printed on the invoice.') }, ['invoice']),
    run: W.updateInvoice },
  { name: 'list_invoices', title: 'List invoices', annotations: RO,
    description: 'Invoices with number, client, project, dates, total, paid, amount due and state (draft, unpaid, part-paid, overdue, paid, cancelled). Defaults to open ones (sent and not fully paid).',
    inputSchema: obj({ filter: { type: 'string', enum: ['open', 'overdue', 'draft', 'paid', 'cancelled', 'all'] }, client: str('Client name, or part of it.') }),
    run: read((l, a) => l.listInvoices(a)) },
  { name: 'get_invoice', title: 'Invoice details', annotations: RO,
    description: 'One invoice in full: line items, payments linked to it, amount due, reminders so far, and the UPI payment link.',
    inputSchema: obj({ invoice: str('Invoice number or its last part, like "001".') }, ['invoice']), run: read((l, a) => l.getInvoice(a)) },
  { name: 'list_overdue', title: 'Overdue invoices by client', annotations: RO,
    description: 'Every overdue invoice, grouped by client with the total owed, days overdue and when they were last reminded. Use it for "who owes me money?".',
    inputSchema: obj({}), run: read(l => l.listOverdue()) },
  { name: 'draft_payment_reminder', title: 'Facts for a payment reminder', annotations: RO,
    description: 'The facts for a payment reminder to one client or for one invoice: amounts, due dates, days overdue, times already reminded, UPI link, WhatsApp number and a suggested tone (friendly, firm after 7 days, final after 30). Write the message from these for the user to send themselves; nothing is sent.',
    inputSchema: obj({ invoice: str('Invoice number.'), client: str('Client name, for all their unpaid invoices.') }), run: read((l, a) => l.reminderFacts(a)) },
  { name: 'log_reminder', title: 'Log that a reminder was sent', annotations: WRITE,
    description: 'Records that the user reminded a client about an invoice (or all their unpaid invoices), so the next reminder can be firmer. Call it after the user says they sent the message.',
    inputSchema: obj({ invoice: str('Invoice number.'), client: str('Client name, for all their unpaid invoices.') }), run: W.logReminder },

  // ---------- renewals ----------
  { name: 'list_renewals', title: 'Renewals and retainers', annotations: RO,
    description: 'Services you renew for clients (domains, hosting, SSL, maintenance, email): what is overdue, what renews soon, every active service with its cost, price, cycle and next renewal, and yearly revenue, cost and profit from them.',
    inputSchema: obj({ within_days: { type: 'integer', minimum: 0, maximum: 366, description: 'How far ahead counts as due. Defaults to 30.' }, include_inactive: { type: 'boolean' } }),
    run: read((l, a) => l.listRenewals(a)) },
  { name: 'add_service', title: 'Add a service to renew', annotations: WRITE,
    description: 'Adds something that renews on a cycle for a client: a domain, hosting, SSL, a maintenance plan, email, or other. Cost is what you pay each cycle, price is what you charge.',
    inputSchema: obj({ client: entrySchema.client, project: str('Project it belongs to (optional).'), name: str('e.g. "geekboz.in" or "Hostinger Business".'),
      kind: { type: 'string', enum: ['domain', 'hosting', 'ssl', 'maintenance', 'email', 'other'] }, provider: str('e.g. GoDaddy, Hostinger.'),
      cost: { type: 'number', minimum: 0, description: 'What you pay each cycle, in rupees.' }, price: { type: 'number', minimum: 0, description: 'What you charge the client each cycle, in rupees.' },
      cycle: { type: 'string', enum: ['monthly', 'quarterly', 'yearly'], description: 'Defaults to yearly.' }, next_renewal: day('Next renewal date'),
      auto_renew: { type: 'boolean' }, notes: str('Anything to remember, like where the login is kept (never the password).') }, ['name', 'next_renewal']),
    run: W.addService },
  { name: 'update_service', title: 'Edit a service', annotations: EDIT,
    description: 'Changes a service\'s details, its next renewal date, or stops it (active: false). Only the fields given are changed.',
    inputSchema: obj({ service: str('Service name or id.'), client: str('Client name, to pick between services with the same name.'), name: str('New name.'),
      kind: { type: 'string', enum: ['domain', 'hosting', 'ssl', 'maintenance', 'email', 'other'] }, provider: str('Provider.'), cost: { type: 'number', minimum: 0 }, price: { type: 'number', minimum: 0 },
      cycle: { type: 'string', enum: ['monthly', 'quarterly', 'yearly'] }, next_renewal: day('Next renewal date'), auto_renew: { type: 'boolean' }, active: { type: 'boolean', description: 'false stops tracking it.' },
      project: str('Project it belongs to. Empty string detaches it.'), notes: str('Notes.') }, ['service']),
    run: W.updateService },
  { name: 'renew_service', title: 'Renew a service', annotations: WRITE,
    description: 'Renews a service in one change: logs what it cost you as an expense, creates a draft invoice to the client for its price, and moves the next renewal forward one cycle. A single undo_change reverses all three. First call without confirm to see the steps.',
    inputSchema: obj({ service: str('Service name or id.'), client: str('Client name, to pick between services with the same name.'),
      log_expense: { type: 'boolean', description: 'Defaults to true (when it has a cost).' }, create_invoice: { type: 'boolean', description: 'Defaults to true (when it has a price).' }, confirm }, ['service']),
    run: W.renewService },

  // ---------- tasks and time ----------
  { name: 'list_tasks', title: 'List tasks', annotations: RO,
    description: 'Tasks (the checklist on a project) with their project, due date and whether they are done or overdue. Defaults to open tasks across every project. Filter by project, client or status.',
    inputSchema: obj({ ...projectRef, status: { type: 'string', enum: ['open', 'overdue', 'done', 'all'], description: 'Defaults to open.' } }),
    run: read((l, a) => l.listTasks(a)) },
  { name: 'list_time', title: 'List time logged', annotations: RO,
    description: 'Hours logged on projects, newest first, with the total and hours per project. Filter by project, client or period. For a project\'s earned-per-hour, use get_project.',
    inputSchema: obj({ ...projectRef, period, from: day('Start date, inclusive'), to: day('End date, inclusive') }),
    run: read((l, a) => l.listTime(a)) },
  { name: 'add_task', title: 'Add tasks to a project', annotations: WRITE,
    description: 'Adds one or more tasks to a project\'s checklist in one change. Each task has a title and an optional due date.',
    inputSchema: obj({ ...projectRef, tasks: { type: 'array', minItems: 1, maxItems: 50, description: 'Tasks to add, e.g. [{"title": "Design homepage"}, {"title": "Launch", "due_date": "2026-11-15"}].',
      items: obj({ title: str('What needs doing.'), due_date: day('Due date') }, ['title']) } }, ['project', 'tasks']),
    run: W.addTasks },
  { name: 'update_task', title: 'Edit or complete a task', annotations: EDIT,
    description: 'Ticks a task off (done: true) or reopens it (done: false), or changes its title or due date. Only the fields given are changed.',
    inputSchema: obj({ task: str('Task title or id.'), ...projectRef, title: str('New title.'), done: { type: 'boolean' }, due_date: str('Due date (YYYY-MM-DD). Empty string clears it.') }, ['task']),
    run: W.updateTask },
  { name: 'delete_task', title: 'Delete a task', annotations: DELETE,
    description: 'Deletes a task. First call without confirm to see which task it is.',
    inputSchema: obj({ task: str('Task title or id.'), ...projectRef, confirm }, ['task']), run: W.deleteTask },
  { name: 'log_time', title: 'Log time on a project', annotations: WRITE,
    description: 'Logs time worked on a project: give minutes or hours (not both), a date (defaults to today) and an optional note. The project then shows its total hours and what it earned per hour.',
    inputSchema: obj({ ...projectRef, minutes: { type: 'integer', minimum: 1, maximum: 1440 }, hours: { type: 'number', exclusiveMinimum: 0, maximum: 24, description: 'Instead of minutes, e.g. 1.5.' },
      date: day('Day the work was done. Defaults to today (India time)'), note: str('What was done.') }, ['project']),
    run: W.logTime },

  // ---------- undo ----------
  { name: 'undo_change', title: 'Undo a change', annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    description: 'Reverts one change made through this connection: the latest one by default, or the one with the given change_id. A change made by one tool call is undone as a whole.',
    inputSchema: obj({ change_id: str('From a tool result or list_recent_changes. Leave out to undo the latest change.') }), run: W.undoChange }
];

const INSTRUCTIONS = `Client Ledger: a freelance web developer's clients, web projects (status, description, preview/live/GitHub links, quoted price, dates) and every payment and expense. All money is in Indian rupees (INR); dates are YYYY-MM-DD in India time.
Reading: "still to collect" is quoted price minus money received, for projects that aren't leads. A project's price can be split into payment milestones; its money received covers them in order, so each is paid, part-paid, unpaid or overdue (past its due date and not fully paid). Some older entries have no date; they only count under all_time.
The financial year runs April to March (FY 2026–27 is 2026-04-01 to 2027-03-31). When the user says "this year" about money, taxes or how the business did, they usually mean the financial year: use this_fy / last_fy, and say which you used.
Invoices: numbered like INV/2026-27/001 per financial year, never deleted (cancel instead). A payment linked to an invoice (add_payment with invoice) counts towards it; an invoice is paid when those reach its total, and overdue when past its due date and not paid. No tax (GST or TDS) is used yet. To chase money, use list_overdue and draft_payment_reminder, write the message yourself for the user to send, then log_reminder once they have sent it. This server never sends messages.
Renewals: services (domains, hosting, SSL, maintenance, email) renew on a monthly, quarterly or yearly cycle with a cost (what the user pays) and a price (what the client pays). renew_service logs the cost, invoices the price and moves the date in one change; it is two-step like deletes.
Tasks and time: each project has a checklist of tasks (title, optional due date, done or not) and logged time (minutes, a date, a note). A project's earned per hour is the money received divided by the hours logged, and only exists once time is logged. Never store client passwords in tasks or notes.
Changing data:
- Before creating or changing anything, make sure you have the details right. If the user's message was vague, sum up what you're about to save and ask first.
- Several projects can share a title (many are called "Website"), so name the client too.
- If a client isn't found, don't guess: check the spelling with the user before creating a new one (create_project with new_client: true).
- Deletes are two-step: call without confirm to get a preview, show it to the user, and only call again with confirm: true after they agree.
- Every change returns a change_id. Tell the user what was saved; undo_change reverts it. Changes show up on the website the next time it's loaded.`;

// Ready-made requests the user can pick in Claude.
const PROMPTS = [
  { name: 'who_owes_me', title: 'Who owes me money?', description: 'Every client who owes money, most overdue first, and who to chase today.',
    text: 'Using the Client Ledger tools, tell me who owes me money. Call list_overdue and list_invoices (filter open), and get_attention_items for projects with money still to collect or overdue milestones. Group it by client, biggest and most overdue first, with days overdue and when I last reminded them. End with who I should chase today, and offer to draft those reminders.' },
  { name: 'weekly_review', title: 'Weekly review', description: 'How the business is doing, what is overdue, and what to do this week.',
    text: 'Give me my weekly review using the Client Ledger tools: get_summary for this_month and this_fy, compare_periods with month_vs_last_month, get_attention_items and list_overdue. Cover money in and out, overdue invoices and milestones, milestones and projects due this week, open leads, and missing information. Finish with the three most useful things to do this week.' }
];

module.exports = { TOOLS, INSTRUCTIONS, PROMPTS };
