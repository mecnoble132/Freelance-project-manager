# Contributing

How to work on Client Ledger, for whoever picks it up next, human or AI. Read this before changing anything. For what the app does and how to set it up, see [README.md](README.md); for the MCP server, [docs/mcp.md](docs/mcp.md); for tests, [tests/README.md](tests/README.md).

The project is tuned for **few bugs and fast delivery**: the existing data isn't precious, so there are no backups or test copies. Bugs are caught by automated tests instead, and every feature must add tests for what it builds.

Money is in rupees, dates are `YYYY-MM-DD` in India time, and the owner is the only user.

## Status

| Feature | Status |
|---|---|
| Financial year view | Released |
| Payment milestones | Released |
| Invoices (UPI QR) and chasing payments | Released, without GST or TDS |
| Renewals and retainers | Released |
| Tasks and time | Released |
| Leads and quotes (`lost` status, `quotes` table, follow-up dates) | Skipped: the owner is managing closed deals, not leads |

Notes for the unfinished parts:

- **GST and TDS:** not built. Add them as new nullable columns (`invoices.gst_rate`, `gst`, `subtotal`; `txns.tds` default 0; GSTIN, SAC and GST rate in `settings`) so old rows keep their numbers. With them, received and revenue would become amount + tds, and an invoice with a GSTIN set would be titled "Tax Invoice".
- **Leads and quotes:** would add `source`, `next_follow_up`, `lost_reason` and a `lost` status to `projects` (update all five status lists below), and a `quotes` table shaped like `invoices` (number `Q/2026-27/001`).

## Rules

### Releasing a change

1. Build the change **with its tests** (follow "When you add a feature" in `tests/README.md`). Run `node --test tests/*.test.js` and `node --test tests/e2e/*.test.js`; everything must pass, old tests included, and the GitHub check must be green.
2. Run `supabase/schema.sql` on the live database **before** merging (changes only add things, so the live code keeps working). Run it twice: the second run must succeed too. The owner wants Claude to do this itself, through the Supabase connector (`execute_sql` on the `client-ledger` project), not to ask them. The connector times out on long runs and on `drop policy`, and each timed-out call rolls back: run the file in parts, and for a new table's policy just `create policy` once. Then check the result with queries on `pg_policies`, `pg_constraint` and `pg_indexes`.
3. Merge as soon as the GitHub check is green: the owner wants Claude to merge its own pull requests automatically, without asking. Then go through the feature's checks on the live site and in Claude, plus the checks below. Every check must be an automated test first (server tests for numbers and tools, `tests/e2e/website.test.js` for screens and buttons); on the live site you only glance at it.
4. If something breaks: Vercel → Deployments → Instant Rollback, then fix on a new branch.
5. Update `README.md` (and `docs/mcp.md` for tool changes).

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

- Match the existing code: `h()` builds elements, `sheet()` opens forms, `api.insert/update/del` show the change on screen at once and save in the background, in order (a failed save reverts and shows a message). A new table that other rows point at must also go in `ON_DELETE` in `index.html` (a test checks it against `schema.sql`). Short comments, plain-words labels.
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

### Design decisions

- **Invoice numbers:** `INV/2026-27/001`, restarting each financial year, worked out as the highest existing number + 1 and never reused. A short number like "002" means this financial year's.
- **Invoice statuses:** stored are `draft`, `sent`, `paid`, `cancelled`; part-paid and overdue are worked out. Invoices are cancelled, never deleted. Drafts don't count as owed.
- **Still to collect** = quote − received, for non-leads.
- **Milestones** are covered in order by the project's money received.
- **Renewals:** a monthly cycle from the 31st lands on the month's last day and stays there (31 Jan → 28 Feb → 28 Mar). Renew creates one change (expense, draft invoice, next date) so a single undo reverses it.
- **Reminders:** the server never sends messages; it returns facts and Claude writes the text.

## After every release, quickly check

The automated tests already cover all of this; on the live site it's a quick look to confirm the release went out.

Sign in and out; dashboard numbers for every period; add, edit and delete a payment; project and client pages open; phone width. In Claude: `get_summary`, one write and its undo, and a delete without `confirm` changes nothing.

## Don't

- Add a build step, a framework or npm packages to the website.
- Drop or rename database columns or tables.
- Change `OAUTH_SECRET` (it signs every app out), or change OAuth code without testing a fresh connection from Claude.
- Put the service key anywhere but Vercel's environment variables, or log tokens and passwords.
- Send emails or messages from the server.

## Later

Tax estimates (advance tax, 44ADA), bank statement import, a client portal, contracts, file storage. If this ever becomes a product for others: sign-ups, billing, and moving the MCP server onto row-level security.
