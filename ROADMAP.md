# Roadmap: next steps for Client Ledger

This file is the work plan for turning Client Ledger into the complete hub for running the business. It is written for whoever picks up the work next, human or AI, with no other context. Read all of it before changing anything.

Written 2026-10-23. Update this file at the end of every phase (tick the phase off, note anything that changed).

**Status**

| Phase | What | Status |
|---|---|---|
| 0 | Safety net: tests, staging copy, backups | Not started |
| A | Financial year view and a data-access guard | Not started |
| B | Payment milestones | Not started |
| C | Invoices (with UPI QR and TDS) | Not started |
| D | Chasing payments | Not started |
| E | Renewals and retainers | Not started |
| F | Leads and quotes | Not started |
| G | Tasks and time | Not started |

Do the phases **in this order, one pull request per phase**. Each one builds on the one before (milestones → invoices → reminders), and every phase must be finished, tested and released before the next one starts.

---

## 1. What exists today

Read `README.md` first for what the app does and how it is set up. In short:

- **The website** is one file, `index.html` (HTML, CSS and plain JavaScript, no build step), plus `config.js` (Supabase URL and the public anon key). It talks to Supabase directly from the browser; row-level security keeps each user to their own rows.
- **The database** is Supabase (Postgres). `supabase/schema.sql` is the whole schema. It is written to be run again and again: it only adds what's missing.
  - Tables: `clients`, `projects`, `txns` (money in and out), `activity_log` (every change made through the MCP server, for undo).
- **The MCP server** (so Claude can read and change the ledger) is in `api/`, running as Vercel functions:
  - `api/mcp.js`: the MCP endpoint (JSON-RPC over HTTP, stateless). It checks the OAuth token and passes a per-user database handle to the tools.
  - `api/_lib/tools.js`: every tool's name, description, input schema, and the function it runs. Also `INSTRUCTIONS`, the text Claude reads about how to use the server.
  - `api/_lib/ledger.js`: loads one user's data and computes every number (summaries, periods, attention items, search). Read-only.
  - `api/_lib/writes.js`: every change. Input cleaning helpers, the `Change` class that records each change in `activity_log`, and undo.
  - `api/_lib/supabase.js`: the only code that talks to the database. `forUser(uid)` returns `select / insert / update / updateWhere / remove`, each of which adds `user_id = uid` itself.
  - `api/_lib/oauth.js` and `api/oauth/*`: OAuth 2.1 sign-in for MCP clients. Nothing is stored; everything is signed with `OAUTH_SECRET`.
- **Hosting** is Vercel. `vercel.json` only has rewrites for the OAuth discovery addresses.
- **There are no tests, no CI, no staging copy and no backups yet.** Phase 0 fixes that before anything else changes.

The owner is a freelance web developer in India. All money is in rupees (INR). All dates are `YYYY-MM-DD` in India time. Only the owner's account exists; sign-ups are turned off.

---

## 2. Rules for every phase

### 2.1 How a phase is built and released

Follow these steps in order for every phase. Do not skip any.

1. **Branch.** Create a branch from the latest `main`, one per phase.
2. **Back up production.** Run `node scripts/backup.js` (made in Phase 0) against production and keep the JSON file somewhere safe outside the repo.
3. **Write the database change** in `supabase/schema.sql`, following 2.2.
4. **Run the schema on staging twice.** Supabase SQL editor → paste the whole file → Run. Then run it again. The second run must succeed with no errors and change nothing. If the second run fails, the SQL isn't safe to rerun: fix it.
5. **Write the code**: website, MCP tools, and `INSTRUCTIONS` in `tools.js`, following 2.3 and 2.4.
6. **Run the automated tests**: `node --test tests/`. Everything must pass, old tests included.
7. **Test against staging** using the phase's checklist (each phase lists one): click through the website on the Vercel preview deployment, and call the new and changed MCP tools with `scripts/call-tool.js` (made in Phase 0).
8. **Check that nothing old broke**: run the regression checklist in section 4.
9. **Update the docs**: `README.md` (feature list, tables, tool tables) and the status table at the top of this file.
10. **Release in this order**, which is what keeps production working at every moment:
    1. Run `supabase/schema.sql` on **production** first. Schema changes are additive only (2.2), so the code that is live now keeps working with the new schema.
    2. Merge the pull request. Vercel deploys it.
    3. Smoke-test production: open the website, check the dashboard numbers look as before, and ask Claude for `get_summary`.
11. **If something is wrong after release**: in Vercel → Deployments, use "Instant Rollback" to the previous deployment. Leave the database alone: the new columns and tables do no harm to the old code. Fix forward on a new branch.

### 2.2 Database rules

- **Additive only.** Add tables and columns; never rename or drop a column, never change a column's type, never delete data in a migration. If something must go, stop using it in code and leave it in the database.
- **Safe to rerun.** Use `create table if not exists`, `alter table … add column if not exists`, `create index if not exists`, and for constraints and policies, `drop … if exists` followed by `create` / `add` (the file already does this; copy its style).
- **New columns** on existing tables need a default (`not null default ''`, `default 0`) or be nullable, so old rows and old code are fine.
- **Every new table** gets the same shape as the existing ones:
  ```sql
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  ...
  created_at timestamptz not null default now()
  ```
  plus an index on `user_id`, `alter table … enable row level security`, and an "own rows" policy written exactly like `"own clients"`.
- **Every new table must be added to the `activity_log` table list**, or MCP changes to it will be refused by the database. The list is the inline check on `activity_log.table_name`, which Postgres names `activity_log_table_name_check`. Replace it like this, listing every table:
  ```sql
  alter table public.activity_log drop constraint if exists activity_log_table_name_check;
  alter table public.activity_log add constraint activity_log_table_name_check
    check (table_name in ('clients', 'projects', 'txns', 'milestones' /* , ...each new table */));
  ```
- **Foreign keys to a project or client**: use `on delete cascade` for rows that mean nothing without their parent (milestones, tasks), and `on delete set null` for rows that should survive (a payment's link to an invoice). Then see 2.4 about deletes and undo.
- **Money** columns are `numeric(12, 2)` with a `check (… >= 0)` or `> 0`. **Dates** are `date`, not timestamps.
- Never put secrets in the schema or in `config.js`. The service_role key lives only in Vercel's environment variables.

### 2.3 Website rules (`index.html`)

- Keep the existing style: the `h()` helper builds elements, `sheet()` opens the bottom sheet for forms, `field()` wraps a labelled input, `api.insert / update / del` write and then reload everything. Match the comment density (short comments, only where something isn't obvious) and the plain-words copy ("Still to collect", "Money in").
- **Routing** is in `parseHash()`: a new page needs its name added to the list there and a `render…` function added to the map in `render()`. Keep the four main tabs (Dashboard, Projects, Clients, Money); add at most one more tab (Invoices, in Phase C). Everything else goes inside existing pages.
- **Loading new tables**: `TABLES` and `map` near the end of the file list what `load()` fetches. A new table must be added there, but **load it so a missing table gives an empty list instead of breaking the whole app** (show a small note "Run supabase/schema.sql to turn on <feature>"). The app must never go blank because the schema wasn't rerun.
- **Statuses and categories are defined twice**, once here (`STATUSES`, `CATEGORIES`) and once in `api/_lib/ledger.js`. Change both together. The status list also lives in the `projects_status_check` constraint in the schema, in `statusIn` in `tools.js`, and in the `status()` helper in `writes.js`.
- **Dates**: the website uses the browser's local date (the owner is in India); the server uses `todayIST()`. Keep both.
- Works on a phone: test every new screen at 375px wide, in light and dark mode.
- Website edits are not written to `activity_log` (only MCP changes are). That is fine; don't change it.

### 2.4 MCP rules (`api/`)

- **Every database call goes through `forUser()`** in `api/_lib/supabase.js`. Never call the REST API or use the service key anywhere else. Phase A adds a test that enforces this.
- **Reading**: add new data to `load()` in `ledger.js` and keep it in `Ledger`. `Ledger` is constructed as `new Ledger(clients, projects, txns)` in several places in `writes.js`; add new data as an optional fourth argument (`extra = {}`), so existing calls keep working. Like the website, a missing new table should load as an empty list.
- **Writing**: copy the shape of the existing write functions exactly:
  1. `const L = await load(db);` then clean every input with the helpers (`text`, `money`, `date`, `url`, …). Bad input → `fail('Plain message.')`. Something not found or ambiguous → `return { error: '…' }` from the `resolve…` helpers, so Claude can ask the user.
  2. `const ch = new Change(db, 'Summary of the change'); await ch.ready();`
  3. Make every row change through `ch.insert / ch.update / ch.remove` (never `db.*` directly), so it is logged.
  4. `return done('What was saved.', { …details }, await ch.commit());`
- **Deletes are two-step**: without `confirm: true`, return `confirmFirst(…)` with a preview; only delete when called again with `confirm: true`.
- **Deletes and undo**: if deleting a row would cascade-delete children in the database (a project's milestones), remove those children explicitly with `ch.remove` *before* the parent, like `deleteClient` does with projects and money. Otherwise the cascade deletes them silently and undo can't bring them back. Also update `deleteClient` and `deleteProject` to include every new child table.
- **Undo** (`undoChange` in `writes.js`) has two lists to extend for every new table: the `current` map of existing rows, and the dependency check that refuses to undo an insert when something newer depends on it (for example, undoing "add project" while milestones were added to it later).
- **Tools**: add each tool to `TOOLS` in `tools.js` with a clear `title`, a description that says when to use it, an `inputSchema` built with `obj()` (which sets `additionalProperties: false`), and the right annotations (`RO`, `WRITE`, `EDIT`, `DELETE`). Accept names as well as ids (a client name, "GeekBoz Website"), like the existing tools.
- **Update `INSTRUCTIONS`** in `tools.js` whenever a new concept appears (milestones, invoices, …): one or two lines saying what it is and any rule Claude must follow. This text is what Claude reads first.
- Tool results are JSON. Keep field names readable for Claude (`stillToCollect`, `daysOverdue`), and include ids so follow-up calls can use them.

### 2.5 Money rules (decided, don't change without asking the owner)

- **Still to collect** for a project = quoted price − money received, for projects that aren't leads (unchanged).
- From Phase C, a payment can have **TDS** (tax the client deducted and paid to the government for the owner). `txns.amount` stays the cash that arrived; `txns.tds` is the amount deducted. **Money received for a project or invoice = amount + tds**, and **revenue = amount + tds**. The dashboard and `get_summary` also show total TDS for the period. Old rows have `tds = 0`, so their numbers don't change.
- **Milestones are covered in order**: a project's money received fills its milestones one by one, in milestone order. A milestone is paid when it is fully covered, part-paid when partly covered, and overdue when its due date has passed and it isn't fully covered. This works with or without invoices.
- **An invoice is paid** when the payments linked to it (amount + tds) add up to its total; part-paid when some are linked. Cancelled invoices are never owed.
- Amounts are rounded to 2 decimal places (`round()` in `ledger.js`, `money()` in `writes.js`).

---

## 3. The phases

Each phase lists: what to build (database, website, MCP), the decisions already made, the tests to write, the manual checklist, and when it counts as done.

### Phase 0: Safety net

Nothing visible changes. This phase makes the rest safe.

**Build**

1. **Automated tests** with Node's built-in test runner (no packages to install). Create `tests/`:
   - `tests/fake-db.js`: an in-memory database with the same methods as `forUser()` (`uid`, `select(table, filters)`, `insert`, `update`, `updateWhere`, `remove`). It must add `id` (use `crypto.randomUUID()`) and `created_at` on insert, add `user_id`, and only return rows for its own `uid`. This lets every tool run without Supabase.
   - `tests/ledger.test.js`: seed a few clients, projects and money entries and check `summary()` (revenue, spending, profit, margin, still to collect, periods, undated entries counted only under all time), `attention()`, `search()`, `resolveProject()` with duplicate titles.
   - `tests/writes.test.js`: for each write tool, check that it saves the right rows, that bad input is refused with a message, that deletes without `confirm` change nothing, and that `undo_change` puts everything back exactly (compare the whole fake database before and after).
   - `tests/tools.test.js`: every tool has a unique name, a title, a description, an `inputSchema` of type `object` with `additionalProperties: false`, and a `run` function. Also call `api/mcp.js`'s handler for `initialize` and `tools/list` with a fake request and check the response shape.
   - `tests/isolation.test.js`: two users in the fake database; every read tool run as user A returns nothing of user B's, and every write as A leaves B's rows untouched.
   - Run with `node --test tests/`. The cloud development environment has Node installed.
2. **A staging copy** so tests never touch real data:
   - Create a second, free Supabase project ("client-ledger-staging"). Run `supabase/schema.sql` on it, turn off sign-ups, and add a test user (owner does this; never use the real password).
   - In Vercel → Settings → Environment Variables, set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `OAUTH_SECRET` for the **Preview** environment to the staging values, and keep **Production** on the real ones.
   - Change `config.js` so the website picks staging everywhere except the production domain:
     ```js
     // Production uses the real project; preview deployments and localhost use the staging copy.
     const PROD_HOST = '<the production domain>';
     window.LEDGER_CONFIG = location.hostname === PROD_HOST ? { supabaseUrl: '…', supabaseAnonKey: '…' } : { supabaseUrl: '<staging url>', supabaseAnonKey: '<staging anon key>' };
     ```
     Ask the owner for the production domain and the staging keys (anon keys only).
   - Vercel preview deployments may be behind Vercel's deployment protection, which blocks Claude and the MCP Inspector. For MCP testing on previews, use `scripts/call-tool.js` (below), which doesn't need OAuth.
3. **`scripts/backup.js`**: reads `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from the environment, downloads every table for every user, and writes `backup-YYYY-MM-DD.json`. Add `backup-*.json` to `.gitignore`. Also write `scripts/restore.md` explaining how to put a table back from the file (Supabase table editor import, or a small script).
4. **`scripts/call-tool.js`**: `node scripts/call-tool.js <user-id> <tool-name> '<json arguments>'` runs one MCP tool directly against whatever database the environment variables point to (staging) and prints the result. This is how MCP tools are tested in every phase.
5. **`.vercelignore`** with `tests/`, `scripts/` and `backup-*.json`, so they are never served on the website.
6. Optional: a GitHub Actions workflow that runs `node --test tests/` on every pull request.

**Tests and checklist**

- `node --test tests/` passes.
- `scripts/call-tool.js` run against staging returns `get_summary` for the test user.
- `scripts/backup.js` against production writes a file with every table and the right row counts.
- The website on a preview deployment signs in with the staging user and shows staging data; production still shows real data.

**Done when** all of the above work. From now on, every phase must add tests for what it builds.

### Phase A: Financial year view and a data-access guard

**Build**

1. **Indian financial year (1 April – 31 March)**:
   - Website: in `PERIODS` (dashboard), add `['fy','This financial year']` and `['lastfy','Last financial year']`, handled in `periodBuckets()` and `inPeriod()`. A financial year starts 1 April of the current year if today is in April or later, else 1 April of last year. Show the label as "FY 2026–27". Make "This financial year" the default period instead of "This year" (the saved preference in `localStorage` still wins).
   - The Money page shares the same `PERIODS` list and `inPeriod()`, so it gets the new periods automatically; check it.
   - MCP: in `ledger.js`, add `this_fy` and `last_fy` to `PERIODS` and `periodRange()`, and a `fy_vs_last_fy` preset to `compare_periods` (in `ledger.js` and in its enum in `tools.js`). Keep `this_year` and `last_year` working as calendar years.
2. **Data-access guard**: a test (`tests/guard.test.js`) that reads every `.js` file in `api/` and fails if any file other than `api/_lib/supabase.js` contains `SUPABASE_SERVICE_ROLE_KEY` or `/rest/v1`, and fails if `supabase.js` exports anything that can query without a user (today it exports `forUser`, `signIn`, `userStillActive`, `DbError`, `UUID`; the raw `rest()` must stay private).

**Note on database access.** The MCP server uses the service_role key, which bypasses row-level security, and `forUser()` adds the `user_id` filter to every operation itself. Because every query goes through that one function, this is safe for a single owner, and the guard test keeps it that way. Moving the server onto row-level security (querying as the signed-in user) is only needed before other people's data is in the database (a SaaS). It isn't simple: it needs either a Supabase-issued token for the user on every request, or minting one, and Supabase's newer signing keys make minting harder. Leave it out of this roadmap; revisit it if the app ever becomes multi-user.

**Tests**: financial-year boundaries (31 March vs 1 April, January dates belong to the previous FY's year label), `compare_periods` with the new preset, the guard test.

**Checklist**: dashboard "This financial year" totals equal the sum of entries from 1 April to today (check against the Money page with the same period); `get_summary` with `period: this_fy` gives the same numbers; switching between periods still works; the chart shows April to March.

**Done when** the website and Claude agree on financial-year numbers and the guard test passes.

### Phase B: Payment milestones

**Decisions**: a project's quote is split into milestones (for example 50% advance, 30% on design, 20% on launch). Payments aren't linked to a milestone; they cover milestones in order (2.5).

**Database**: a `milestones` table:
- `project_id uuid not null references projects(id) on delete cascade`
- `name text not null` (e.g. "Advance", "Design approved", "Launch")
- `amount numeric(12,2) not null check (amount > 0)`
- `due_date date` (nullable)
- `sort_order integer not null default 0`
- plus the standard columns, RLS policy, index on `user_id` and on `project_id`, and `'milestones'` added to the `activity_log` list.

**Website**
- Project page: a "Milestones" section listing each milestone with amount, due date and its state (Paid, Part-paid ₹X of ₹Y, Due on <date>, Overdue by N days).
- An "Edit milestones" sheet: quick splits (50/50, 50/30/20, 40/40/20, or custom), editable names, amounts and due dates, and a running total that warns when it doesn't equal the quoted price (a warning, not a block).
- Project cards and the dashboard's "Still to collect": show "₹X overdue" when any milestone is overdue.

**MCP**
- `set_milestones` (EDIT): replaces a project's whole milestone list in one change. Input: project (+ client), and either `split` (e.g. `[50, 30, 20]` as percentages of the quote) or a `milestones` array of `{ name, amount, due_date }`. Refuses when the total is more than the quoted price unless `allow_over_quote: true`.
- `get_project`: include milestones with their state.
- `get_attention_items`: add overdue milestones (with amounts and days overdue) and milestones due within 7 days.
- `get_summary` / `list_projects`: add `overdueAmount` next to `stillToCollect`.
- `deleteProject`: removes milestones explicitly before the project (2.4). Undo: add `milestones` to the `current` map and to the dependency check for undoing a project insert.
- `INSTRUCTIONS`: explain milestones and that payments cover them in order.

**Tests**: covering in order (payment smaller than the first milestone, exactly equal, spanning two milestones, more than the total); overdue calculation; `set_milestones` with a split, custom list, and over-quote refusal; undo of `set_milestones` restores the previous list; deleting a project and undoing it brings back its milestones.

**Checklist**: add milestones to a staging project on the website, log a payment that covers the first one, check the states change; do the same through `call-tool.js`; check a project without milestones looks exactly as before.

**Done when** every project can have milestones, and "what's overdue" is shown on the website and returned to Claude.

### Phase C: Invoices (with UPI QR and TDS)

The biggest phase. Consider splitting it into two pull requests: C1 (settings and invoices) and C2 (UPI QR, PDF and payments against invoices).

**Decisions**
- **Invoice numbers**: `<prefix>/<FY>/<sequence>`, e.g. `INV/2026-27/001`. The sequence restarts each financial year. It is worked out when the invoice is created as the highest existing sequence in that financial year + 1, so there's no counter to go wrong. Numbers are never reused; cancelled invoices keep their number. Add a unique index on `(user_id, number)`.
- **GST**: if the owner has a GSTIN in settings, invoices are titled "Tax Invoice" and add GST at the settings rate (default 18%) on top of the line items. Without a GSTIN, the title is "Invoice" and no GST is added. The SAC code (commonly 998314 for IT design and development services; the owner should confirm with their accountant) is a setting printed on each invoice. Don't build anything more complex for GST (no IGST/CGST split, no e-invoicing) unless the owner asks.
- **PDF** is made by the browser's Print → Save as PDF, using a print stylesheet. No PDF library, no server.
- **UPI QR**: the invoice shows a QR code for `upi://pay?pa=<UPI ID>&pn=<business name>&am=<amount still due>&cu=INR&tn=<invoice number>`. Draw it in the browser with a small QR library from a CDN, pinned to an exact version (e.g. `qrcode-generator` from cdnjs or jsdelivr). Also show the UPI ID and bank details as text.
- **Statuses**: `draft`, `sent`, `paid`, `cancelled` are stored. "Part-paid" and "Overdue" are worked out (2.5), not stored. An invoice is marked `paid` automatically when its payments cover the total, and goes back to `sent` if a payment is removed.

**Database**
- `settings` table, one row per user (unique index on `user_id`): `business_name`, `address`, `phone`, `email`, `gstin`, `pan`, `sac_code`, `gst_rate numeric(5,2) default 18`, `upi_id`, `bank_name`, `bank_account`, `bank_ifsc`, `invoice_prefix default 'INV'`, `payment_terms_days integer default 7`, `invoice_notes` (printed at the bottom), all text defaulting to `''`.
- `invoices` table: `client_id` (not null, cascade), `project_id` (nullable, set null), `milestone_id` (nullable, set null), `number text not null`, `issue_date date not null`, `due_date date`, `items jsonb not null default '[]'` (each `{ description, quantity, rate }`), `gst_rate numeric(5,2) not null default 0` (copied from settings when created, so later settings changes don't alter old invoices), `subtotal`, `gst`, `total` (all `numeric(12,2)`, recomputed on every save), `status text not null default 'draft'` with a check, `notes text default ''`, `sent_at date`, plus standard columns.
- `txns`: add `invoice_id uuid references invoices(id) on delete set null` and `tds numeric(12,2) not null default 0 check (tds >= 0)`.
- Add `'settings'` and `'invoices'` to the `activity_log` list.

**Website**
- **Settings sheet** (opened from a small "Settings" link in the header): the business details above. Invoices can't be created until business name and either a UPI ID or bank details are filled in; the app says so and links to the sheet.
- **Invoices tab** (the one new tab): a list of invoices with number, client, total, status and days overdue, with filters (All, Unpaid, Overdue, Paid, Draft).
- **New invoice** from: a project's milestone ("Invoice this milestone": one line item with the milestone name and amount, due date from the milestone or payment terms), a project (line items from scratch), or a client (no project).
- **Invoice page**: looks like a real invoice (business details, client, number, dates, items, GST, total, amount paid, amount due, UPI QR, bank details, notes) with buttons: Print / Save PDF, Mark as sent, Record payment, Edit, Cancel invoice. The print stylesheet hides everything but the invoice.
- **Record payment** (from an invoice, or from the existing money sheet with an "Invoice" picker): amount, TDS deducted (optional), date, note. Saved as a `txns` row with `invoice_id` and `tds`.
- Project and client pages: list their invoices.
- Dashboard: revenue now includes TDS (2.5) and shows "TDS deducted" for the period.

**MCP**
- `get_settings` (RO) and `update_settings` (EDIT).
- `create_invoice` (WRITE): from a `milestone` (name or id), or with `items`; client and project by name; dates default from settings. Returns the invoice with its number, totals and a link to its page on the website (`<site>/#/invoice/<id>`).
- `update_invoice` (EDIT): items, dates, notes, status (`sent`, `cancelled`). Refuses to edit items on a paid invoice.
- `list_invoices` (RO): filter by status (including `unpaid` and `overdue`), client, project, period.
- `get_invoice` (RO): everything, including payments against it and amount due.
- `add_payment`: new optional `invoice` (number or id) and `tds` inputs. When an invoice is given, client and project come from it.
- `get_summary`, `get_client`, `get_project`, `get_attention_items`: include invoice totals, unpaid and overdue invoices, and TDS.
- Undo and deletes: add `invoices` and `settings` to undo; `delete_invoice` is not needed (cancel instead). Deleting a client or project removes its invoices explicitly first (2.4).
- `INSTRUCTIONS`: invoices, numbering, cancel instead of delete, TDS.

**Tests**: invoice numbering (first of the FY, after a cancelled one, across the 1 April boundary); totals with and without GST; paid/part-paid/overdue; a payment with TDS settling an invoice; removing a payment reopens it; revenue with TDS; the UPI link text (amount due, invoice number, properly encoded); undo of create and update; isolation (user A can't see or pay user B's invoices).

**Checklist**: on staging, fill in settings; make an invoice from a milestone; open it, print to PDF on a phone and a computer (check it fits one A4 page and dark mode doesn't leak into print); scan the QR with a UPI app and check the payee, amount and note are right (don't pay); record a part payment with TDS, then the rest; check the invoice, project, client and dashboard all agree; do the same through `call-tool.js`.

**Done when** a milestone can be invoiced, printed, paid by UPI, recorded with TDS, and every page and tool agrees on what's owed.

### Phase D: Chasing payments

**Decisions**: the server never sends messages itself. It returns the facts; the owner (or Claude, with the owner's email or WhatsApp) sends them. India runs on WhatsApp, so the website offers a WhatsApp link.

**Database**: on `invoices`, add `last_reminded date` and `reminder_count integer not null default 0`.

**Website**
- A "To collect" section at the top of the Invoices tab (and a card on the dashboard): unpaid invoices grouped by client, with amount due, days overdue and when last reminded.
- On each unpaid invoice: "Copy reminder" (a short polite message with the invoice number, amount due, due date, UPI ID and a link to the invoice) and "Send on WhatsApp" (`https://wa.me/<number>?text=<message>`, shown when the client's contact contains a phone number; assume +91 for 10-digit numbers). Either one asks "Mark as reminded today?" and sets `last_reminded`, `reminder_count`.
- Tone gets firmer with time: up to 7 days overdue friendly, 8–30 days firm, over 30 days final. Keep the wording in one place so it is easy to edit.

**MCP**
- `list_overdue` (RO): every unpaid invoice past its due date (and overdue milestones without an invoice), grouped by client, with contact, amount due, days overdue, last reminded and reminder count.
- `draft_payment_reminder` (RO): for one client or invoice, returns the facts Claude needs to write the message (client name and contact, invoices, amounts, days overdue, UPI ID, invoice link, previous reminders, suggested tone). It does not write the message; Claude does, in the language the owner asks for (English, Hindi, Hinglish…).
- `log_reminder` (EDIT): marks invoices as reminded today (or a given date).
- **MCP prompts** (the first ones): add `prompts: { listChanged: false }` to the capabilities in `api/mcp.js`'s `initialize`, and handlers for `prompts/list` and `prompts/get`. Keep the prompts in a `PROMPTS` list in `tools.js` next to `TOOLS`. Two prompts:
  - `who_owes_me`: "List everyone who owes me money, oldest first, and draft a reminder for each one that's overdue."
  - `weekly_review`: "Give me this week's review: money in and out, overdue payments, projects due in the next 7 days, leads to follow up, and the three things I should do first."
- `INSTRUCTIONS`: never claim a reminder was sent unless the owner sent it; call `log_reminder` after they confirm.

**Tests**: overdue grouping, days overdue, tone by days, WhatsApp link building (10-digit number, number with +91, contact that's an email → no link), message text encoding, `log_reminder` and its undo, `prompts/list` and `prompts/get` responses.

**Checklist**: on staging, with an overdue invoice, copy the reminder and open the WhatsApp link (check the text, don't send to a real client); mark as reminded and check it shows; ask Claude (connected to a preview, or via `call-tool.js`) for `list_overdue` and `draft_payment_reminder`.

**Done when** the owner can see who owes what and send a reminder in two taps, and Claude can do the same.

### Phase E: Renewals and retainers

**Decisions**: a "service" is anything that renews for a client: a domain, hosting, SSL, a maintenance plan. It has a cost to the owner and a price to the client. Renewing is one action that logs the expense, makes the invoice and moves the date forward.

**Database**: a `services` table:
- `client_id` (not null, cascade), `project_id` (nullable, set null)
- `kind text not null` with a check: `domain`, `hosting`, `ssl`, `maintenance`, `email`, `other`
- `name text not null` (e.g. "geekboz.com", "Hostinger Business")
- `provider text default ''`
- `cost numeric(12,2) not null default 0` (what the owner pays), `price numeric(12,2) not null default 0` (what the client pays)
- `cycle text not null default 'yearly'` with a check: `monthly`, `quarterly`, `yearly`
- `next_renewal date`
- `auto_renew boolean not null default false` (whether the provider charges automatically)
- `active boolean not null default true`
- `notes text default ''`
- plus the standard columns, and `'services'` added to the `activity_log` list.

**Website**
- Dashboard: a "Renewals" card showing anything renewing in the next 30 days, and anything already past its date in red.
- A renewals page (`#/renewals`, opened from that card; not a new tab) listing every active service with next date, cost, price, profit per year, and a total yearly profit from services.
- Client page: a "Services" section with add and edit.
- "Renew" button on a service: in one sheet, confirm the amounts, then (1) log the expense (`txns`, category Domain or Hosting from the kind, else Other), (2) create an invoice for the client price (if the price is above 0), (3) move `next_renewal` forward by one cycle. Show what will happen before doing it.

**MCP**
- `list_renewals` (RO): services renewing within N days (default 30) and overdue ones, with cost, price and profit.
- `add_service` (WRITE), `update_service` (EDIT) (including `active: false` to stop one).
- `renew_service` (WRITE): does the three steps above as **one** change, so a single `undo_change` reverses all of them. Two-step like deletes: without `confirm: true`, return what it will do.
- `get_client`, `get_attention_items`: include services and renewals due.
- Deletes and undo for `services` (2.4).
- `INSTRUCTIONS`: services and renewals.

**Tests**: next-date maths (monthly from 31 January, yearly from 29 February), profit per year by cycle, `renew_service` creates the expense, the invoice and the new date, and its undo removes all three; services of a deleted client.

**Checklist**: add the owner's real list of domains and hosting to staging (or a sample), check the 30-day card, renew one and check the expense, the invoice and the new date; same via `call-tool.js`.

**Done when** every domain and hosting plan is tracked, renewals show up a month ahead, and renewing takes one action.

### Phase F: Leads and quotes

**Decisions**: leads stay as projects with status `lead` (no new leads table). A new `lost` status records leads that didn't happen. Quotes have their own table and become the project's price when accepted.

**Database**
- `projects`: add `source text default ''` (where the lead came from: referral, Instagram, Google, past client, other), `next_follow_up date`, `lost_reason text default ''`.
- Add `lost` to the project statuses: replace `projects_status_check` with one that includes `'lost'`, and update every other place statuses are listed (2.3). Lost projects count like leads: nothing to collect.
- `quotes` table: `project_id` (not null, cascade), `number text not null` (`Q/<FY>/<sequence>`, same rules as invoices), `issue_date`, `valid_until date`, `items jsonb`, `gst_rate`, `subtotal`, `gst`, `total`, `status text` with a check (`draft`, `sent`, `accepted`, `declined`), `notes`, plus standard columns, and `'quotes'` added to the `activity_log` list.

**Website**
- Projects tab: a "Pipeline" filter showing leads in columns or groups: New lead → Quote sent → Won / Lost, with the follow-up date on each card and overdue follow-ups highlighted.
- Lead project page: source, next follow-up, quotes.
- Quote page: same look and print stylesheet as invoices (reuse the invoice layout code; don't copy it), titled "Quotation".
- "Accept quote": sets the quote `accepted`, the project `active`, its quoted price to the quote total, and opens the milestones sheet. "Mark as lost": asks for the reason.
- Dashboard: "Leads to follow up" (next follow-up today or earlier), and the pipeline value (sum of open quotes).

**MCP**
- `create_quote` (WRITE), `update_quote` (EDIT), `list_quotes` (RO).
- `accept_quote` (EDIT): one change that sets the quote, the project status and its quoted price, and optionally milestones (`split: [50, 30, 20]`).
- `list_followups` (RO): leads whose follow-up date is today or earlier, plus leads with no follow-up date.
- `update_project`: accepts `source`, `next_follow_up`, `lost_reason`, and status `lost`.
- Prompt: `leads_to_follow_up`: "Which leads should I follow up today? Draft a short message for each."
- Undo, deletes, `INSTRUCTIONS` as usual.

**Tests**: status `lost` everywhere (website lists, `list_projects` filters, summary counts, still to collect = 0), quote numbering, `accept_quote` and its undo, follow-up lists.

**Checklist**: on staging, add a lead with a source and follow-up date, make a quote, print it, accept it with a 50/30/20 split, check the project, milestones and dashboard; mark another lead lost; same via `call-tool.js`. Check existing projects look unchanged.

**Done when** a lead can go from first enquiry to quote to active project with milestones without retyping anything.

### Phase G: Tasks and time

**Decisions**: keep it light. A checklist per project, and an optional time log, so the owner can see what they really earn per hour. **Do not store client passwords or credentials in the app**; the owner should keep those in a password manager. A client's notes can say where they're kept.

**Database**
- `tasks` table: `project_id` (not null, cascade), `title text not null`, `done boolean not null default false`, `due_date date`, `sort_order integer default 0`, `done_at date`, plus standard columns.
- `time_entries` table: `project_id` (not null, cascade), `date date not null`, `minutes integer not null check (minutes > 0)`, `note text default ''`, plus standard columns.
- Both added to the `activity_log` list.

**Website**
- Project page: a checklist (add, tick, reorder, delete) and a "Time" section with a quick "Log time" (hours and minutes, date, note) and the total.
- Project page and the dashboard's top projects: "Earned per hour" = money received ÷ hours logged (only when time was logged).
- Dashboard: tasks due in the next 7 days and overdue tasks.

**MCP**
- `add_task` (WRITE; accepts several tasks at once), `update_task` (EDIT; tick off, rename, change date), `list_tasks` (RO; by project, or everything due soon), `delete_task` (DELETE, two-step).
- `log_time` (WRITE), `list_time` (RO; totals by project and period).
- `get_project`, `get_attention_items`, `get_summary`: tasks due, hours and earned per hour.
- Undo, deletes (a project's tasks and time entries removed explicitly before the project), `INSTRUCTIONS`.

**Tests**: earned per hour (no time logged → no figure), tasks due soon and overdue, deleting a project with tasks and time and undoing it, adding several tasks in one change and undoing it.

**Checklist**: on staging, add tasks and time to a project, tick tasks off, check earned per hour; same via `call-tool.js`; check a project with no tasks looks as before.

**Done when** each project shows what's left to do, how long it took, and what it really earned per hour.

---

## 4. Regression checklist (run at the end of every phase)

On the preview deployment (staging data) and, after release, on production:

- Sign in, sign out, and "Forgot password" still work.
- Dashboard: every period shows numbers; "Still to collect" matches the Projects page; the chart draws; undated entries note shows when there are undated entries.
- Projects: filters and search work; a project page opens, edits and saves.
- Clients: list, client page, add and edit work.
- Money: add, edit and delete a payment and an expense; filters work.
- Phone width (375px), light and dark mode: nothing overflows.
- MCP (`call-tool.js` on staging, Claude on production): `get_summary`, `list_projects`, `get_attention_items`, one write (`add_payment` to a test client), `undo_change` for it, and a delete without `confirm` (must change nothing).
- After release: in Claude, Settings → Connectors, the Client Ledger connector still connects and lists its tools (the new ones included).

---

## 5. Things not to do

- Don't add a build step, a framework or npm dependencies to the website. If a library is truly needed, load it from a CDN with an exact version.
- Don't change existing numbers' meaning except where section 2.5 says so.
- Don't drop or rename columns or tables, or rewrite existing rows in a migration.
- Don't turn sign-ups on, or change OAuth (`api/oauth/*`, `api/_lib/oauth.js`) unless a phase needs it. If it must change, test connecting from Claude on a preview before release, because a mistake there disconnects the owner.
- Don't change `OAUTH_SECRET`: it signs every connected app out.
- Don't put the service_role key anywhere but Vercel's environment variables, or log tokens, codes, passwords or full request bodies.
- Don't send emails or WhatsApp messages from the server.
- Don't start the next phase until the current one is released and its checklist passed on production.

## 6. Later (not in this plan)

Ideas the owner may want after Phase G, in no particular order: tax estimates (advance tax dates, section 44ADA view, TDS matching with Form 26AS), bank statement import, a client portal (read-only link with progress, invoices and a Pay button), contract templates, file storage, and, only if the app becomes a product for other freelancers, sign-ups, billing, teams, and moving the MCP server onto row-level security (see the note in Phase A).
