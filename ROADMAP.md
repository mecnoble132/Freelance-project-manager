# Roadmap: next steps for Client Ledger

The work plan for the next features, for whoever picks it up next, human or AI. Read it all before changing anything, and tick off each phase in the table when it's released.

| Phase | What | Status |
|---|---|---|
| A | Financial year view (the automated tests are done) | Released |
| B | Payment milestones | Released |
| C | Invoices (UPI QR) and chasing payments, without GST or TDS for now | Released |
| D | Renewals and retainers | Released |
| E | Leads and quotes | Not started |
| F | Tasks and time | Not started |

One pull request per phase, in this order: each builds on the one before.

The plan is tuned for **few bugs and fast delivery**: the existing data isn't precious, so there are no backups or test copies. Bugs are caught by automated tests instead, and every phase must add tests for what it builds.

---

## 1. What exists today

See `README.md` for features and setup. In short:

- **Website**: `index.html` (HTML, CSS, plain JavaScript, no build step) and `config.js`. Talks to Supabase from the browser; row-level security keeps each user to their own rows.
- **Database**: Supabase. `supabase/schema.sql` is the whole schema and is safe to run again. Tables: `clients`, `projects`, `txns` (money in/out), `activity_log` (MCP changes, for undo).
- **MCP server** (`api/`, Vercel functions):
  - `api/mcp.js`: the endpoint. Checks the OAuth token, hands the tools a per-user database handle.
  - `api/_lib/tools.js`: tool definitions (`TOOLS`) and `INSTRUCTIONS`, the text Claude reads first.
  - `api/_lib/ledger.js`: loads data and computes every number. Read-only.
  - `api/_lib/writes.js`: every change, input cleaning, the `Change` class (logs to `activity_log`), and undo.
  - `api/_lib/supabase.js`: the only database access. `forUser(uid)` adds `user_id = uid` to every operation.
  - `api/oauth/*`, `api/_lib/oauth.js`: sign-in for MCP clients. Don't touch unless needed.
- Automated tests are in `tests/` (see `tests/README.md`). They run offline against a fake Supabase built from `schema.sql`, and GitHub runs them on every pull request.

Money is in rupees, dates are `YYYY-MM-DD` in India time, and the owner is the only user.

---

## 2. Rules

### Releasing a phase

1. Build the phase **with its tests** (follow "When you add a feature" in `tests/README.md`). Run `node --test tests/*.test.js` and `node --test tests/e2e/*.test.js`; everything must pass, old tests included, and the GitHub check must be green.
2. Run `supabase/schema.sql` on the live database **before** merging (changes only add things, so the live code keeps working). Run it twice: the second run must succeed too. The owner wants Claude to do this itself, through the Supabase connector (`execute_sql` on the `client-ledger` project), not to ask them. The connector times out on long runs and on `drop policy`, and each timed-out call rolls back: run the file in parts, and for a new table's policy just `create policy` once. Then check the result with queries on `pg_policies`, `pg_constraint` and `pg_indexes`.
3. Merge as soon as the GitHub check is green: the owner wants Claude to merge its own pull requests automatically, without asking. Then go through the phase's **Check** list on the live site and in Claude, plus section 4. Every item in a **Check** list must be an automated test first (server tests for numbers and tools, `tests/e2e/website.test.js` for screens and buttons); on the live site you only glance at it.
4. If something breaks: Vercel → Deployments → Instant Rollback, then fix on a new branch.
5. Update `README.md` and the table above.

### Database

- **Only add**, never rename, drop or rewrite. Use `if not exists` / `drop … if exists` so the file can be run again (copy the existing style).
- New columns need a default or must be nullable.
- New tables copy the existing shape: `id`, `user_id` (default `auth.uid()`), `created_at`, an index on `user_id`, row-level security on, and an "own rows" policy like `"own clients"`.
- **Add every new table to the `activity_log` list**, or MCP writes to it fail:
  ```sql
  alter table public.activity_log drop constraint if exists activity_log_table_name_check;
  alter table public.activity_log add constraint activity_log_table_name_check
    check (table_name in ('clients', 'projects', 'txns', /* ...new tables */));
  ```
- Money is `numeric(12, 2)`, dates are `date`.

### Website (`index.html`)

- Match the existing code: `h()` builds elements, `sheet()` opens forms, `api.insert/update/del` save and reload. Short comments, plain-words labels.
- New pages: add the name to `parseHash()` and a `render…` function to the map in `render()`. Add at most one new tab (Invoices).
- New tables go in `TABLES` and `map`. If a table is missing, load it as an empty list, never break the app.
- Project statuses are listed in five places: `STATUSES` here, `ledger.js`, `statusIn` in `tools.js`, `status()` in `writes.js`, and the `projects_status_check` constraint. Expense categories are listed in two: here and in `ledger.js`. Change every copy together.
- Check new screens at phone width, in light and dark mode.

### MCP (`api/`)

- All database calls go through `forUser()`. Never use the service key or REST API anywhere else.
- New data: add it to `load()` in `ledger.js`, passed to `Ledger` as an optional fourth argument so existing calls still work.
- Write tools copy the existing pattern: `load` → clean inputs (`fail()` for bad input, `return { error }` when something isn't found) → `new Change(db, summary)`, `await ch.ready()` → only `ch.insert/update/remove` → `return done(…, await ch.commit())`.
- Deletes are two-step (`confirmFirst` until `confirm: true`). Before deleting a parent, remove its children with `ch.remove` so undo can restore them; update `deleteClient` and `deleteProject` for each new child table.
- In `undoChange`, add each new table to the `current` map and to the dependency check.
- Update `INSTRUCTIONS` whenever a new concept appears.

### Money (decided)

- **Still to collect** = quote − received, for non-leads (unchanged).
- **TDS** (from Phase C): `txns.amount` is cash received, `txns.tds` is tax deducted. Received and revenue = amount + tds. Old rows have tds 0, so their numbers don't change.
- **Milestones are covered in order** by the project's money received: paid, part-paid, or overdue (past due and not covered).
- **Invoice paid** when linked payments (amount + tds) reach its total. Cancelled invoices are never owed.

---

## 3. Phases

### A. Financial year

The automated tests are already done (`tests/`). This phase is the financial year view.

- **Financial year (April–March)**:
  - Website: add "This financial year" and "Last financial year" to `PERIODS`, handled in `periodBuckets()` and `inPeriod()`, labelled "FY 2026–27", and make it the default. The Money page shares `PERIODS`.
  - MCP: add `this_fy` / `last_fy` to `PERIODS` and `periodRange()` in `ledger.js`, and a `fy_vs_last_fy` preset to `compare_periods`.
- **Check**: the dashboard and `get_summary` with `this_fy` give the same totals; 31 March and 1 April land in different years; the period pills test in `website.test.js` covers the new pills; `consistency.test.js` checks that the website's and the server's period lists match.

### B. Payment milestones

- **DB**: `milestones` table: `project_id` (cascade), `name`, `amount > 0`, `due_date`, `sort_order`.
- **Website**: a milestones section on the project page showing each one's state. An edit sheet with quick splits (50/50, 50/30/20, custom) that warns when the total isn't the quote. Projects with an overdue milestone show "₹X overdue".
- **MCP**:
  - `set_milestones` replaces the whole list in one change, from a `split` like `[50, 30, 20]` or a list of milestones.
  - Overdue and due-soon milestones are added to `get_project`, `get_attention_items` and `get_summary`.
- **Check**: a payment covering milestone 1, one covering part of milestone 2, overdue dates; undo `set_milestones`; deleting a project and undoing it brings its milestones back.

### C. Invoices

> **As built (Oct 2026):** the owner chose no GST, no TDS and no logo for now, so none of the tax parts below exist yet: no `gst_rate`, `gst` or `subtotal` on `invoices`, no GSTIN or SAC in `settings`, no `txns.tds`, and the invoice is titled "Invoice" with total = sum of its lines. Add them later as new nullable columns (old invoices then have no GST and tds 0, so their numbers don't change). Everything else below was built, plus: a short invoice number like "002" means this financial year's; drafts don't count as owed; deleting a project keeps its invoices with the client.

- **Decisions**:
  - **Number**: `INV/2026-27/001`. Restarts each financial year, worked out as the highest existing number + 1, never reused.
  - **GST**: if a GSTIN is set, the invoice is titled "Tax Invoice" and adds GST at the settings rate (default 18%); otherwise it's titled "Invoice" with no GST.
  - **PDF**: the browser's Print → Save as PDF, with a print stylesheet.
  - **UPI QR**: `upi://pay?pa=<UPI ID>&pn=<name>&am=<due>&cu=INR&tn=<number>`, drawn in the browser with a QR library from a CDN pinned to an exact version.
  - **Statuses**: stored are `draft`, `sent`, `paid`, `cancelled`. Part-paid and overdue are worked out, not stored.
- **DB**:
  - `settings` (one row per user): business name, address, phone, email, GSTIN, SAC code, GST rate, UPI ID, bank details, invoice prefix, payment terms in days, invoice notes.
  - `invoices`: `client_id`, `project_id`, `milestone_id`, `number` (unique per user), issue and due dates, `items` (jsonb: description, quantity, rate), `gst_rate` (copied when created), `subtotal`, `gst`, `total`, `status`, `notes`, `sent_at`.
  - `txns`: add `invoice_id` (set null on delete) and `tds` (default 0).
- **Website**: a settings sheet; an Invoices tab with filters; "Invoice this milestone"; an invoice page (QR, bank details, Print, Mark sent, Record payment with TDS, Cancel). The dashboard shows TDS deducted.
- **MCP**:
  - New tools: `get_settings`, `update_settings`, `create_invoice` (from a milestone or line items), `update_invoice`, `list_invoices` (unpaid / overdue filters), `get_invoice`.
  - `add_payment` takes `invoice` and `tds`.
  - Invoice totals and TDS are added to the summaries.
  - Invoices are cancelled, never deleted.
- **Check**: numbering across 1 April; totals with and without GST; a payment with TDS settles an invoice, and removing it reopens the invoice; scan the QR with a UPI app (don't pay); the PDF fits on one A4 page.

**Chasing payments** (same phase, after invoices work):

- **DB**: on `invoices`, add `last_reminded` and `reminder_count`.
- **Website**: "To collect" on the Invoices tab and the dashboard, grouped by client with days overdue. On each invoice, "Copy reminder" and "Send on WhatsApp" (`https://wa.me/<number>?text=…`, assuming +91 for 10-digit numbers), then "Mark as reminded". Tone gets firmer after 7 and 30 days.
- **MCP**:
  - `list_overdue`.
  - `draft_payment_reminder`: returns the facts only; Claude writes the message.
  - `log_reminder`.
  - The first **MCP prompts**: add `prompts` to the capabilities in `api/mcp.js`, plus `prompts/list` and `prompts/get`. Two prompts: `who_owes_me` and `weekly_review`.
  - The server never sends messages itself.
- **Check**: the WhatsApp link text (open it, don't send); mark as reminded; the prompts appear in Claude.

### D. Renewals and retainers

> **As built (Oct 2026):** Renewals has its own page (`#/renewals`) but no tab, keeping to one new tab; it's reached from the dashboard's Renewals card. A monthly cycle from the 31st lands on the month's last day and stays there (31 Jan → 28 Feb → 28 Mar). Renew's expense category comes from the kind (domain → Domain, hosting → Hosting, SSL and email → Software & plugins, else Other), and a step is skipped when its amount is ₹0. There's no delete tool for services in Claude: stop one with `active: false`.

- **DB**: `services` table:
  - `client_id`, `project_id`
  - `kind`: domain, hosting, ssl, maintenance, email or other
  - `name`, `provider`
  - `cost` (to you), `price` (to the client)
  - `cycle`: monthly, quarterly or yearly
  - `next_renewal`, `auto_renew`, `active`, `notes`
- **Website**: a Renewals card on the dashboard (next 30 days, overdue in red), a `#/renewals` page with yearly profit, and services on the client page. A "Renew" button logs the expense, invoices the client, and moves the date forward one cycle, after showing what it will do.
- **MCP**:
  - New tools: `list_renewals`, `add_service`, `update_service`, and `renew_service` (all three steps in **one** change so a single undo reverses them; two-step confirm).
  - Renewals are added to `get_client` and `get_attention_items`.
- **Check**: date maths (monthly from 31 Jan, yearly from 29 Feb); renew, then undo removes all three.

### E. Leads and quotes

- **DB**:
  - On `projects`, add `source`, `next_follow_up`, `lost_reason`, and a `lost` status (update all five places that list statuses).
  - `quotes` table, shaped like `invoices` with `project_id`, number `Q/2026-27/001`, `valid_until`, and status `draft`/`sent`/`accepted`/`declined`.
- **Website**: a Pipeline filter on Projects (Lead → Quote sent → Won / Lost) with follow-up dates. Quote pages reuse the invoice layout code. "Accept quote" makes the project active, sets its quote, and opens the milestones sheet. "Mark lost" asks for the reason. The dashboard shows leads to follow up today.
- **MCP**:
  - New tools: `create_quote`, `update_quote`, `list_quotes`, `accept_quote` (one change, with an optional milestone split), `list_followups`.
  - `update_project` takes the new fields.
  - New prompt: `leads_to_follow_up`.
- **Check**: lost projects owe nothing and show up in the filters; accept a quote, then undo it.

### F. Tasks and time

- **DB**:
  - `tasks`: `project_id` (cascade), `title`, `done`, `due_date`, `sort_order`, `done_at`.
  - `time_entries`: `project_id` (cascade), `date`, `minutes > 0`, `note`.
  - Don't store client passwords; the client's notes can say where they're kept.
- **Website**: a checklist and "Log time" on the project page; "Earned per hour" (received ÷ hours, only when time was logged); tasks due soon on the dashboard.
- **MCP**:
  - New tools: `add_task` (several at once), `update_task`, `list_tasks`, `delete_task` (two-step), `log_time`, `list_time`.
  - Hours and tasks are added to the project and attention tools.
- **Check**: deleting a project with tasks and time, then undoing it; earned per hour with no time logged shows nothing.

---

## 4. After every phase, quickly check

The automated tests already cover all of this; on the live site it's a quick look to confirm the release went out.

Sign in and out; dashboard numbers for every period; add, edit and delete a payment; project and client pages open; phone width. In Claude: `get_summary`, one write and its undo, and a delete without `confirm` changes nothing.

## 5. Don't

- Add a build step, a framework or npm packages to the website.
- Drop or rename database columns or tables.
- Change `OAUTH_SECRET` (it signs every app out), or change OAuth code without testing a fresh connection from Claude.
- Put the service key anywhere but Vercel's environment variables, or log tokens and passwords.
- Send emails or messages from the server.

## Later

Tax estimates (advance tax, 44ADA), bank statement import, a client portal, contracts, file storage. If this ever becomes a product for others: sign-ups, billing, and moving the MCP server onto row-level security.
