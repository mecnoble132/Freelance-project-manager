# MCP server

`api/mcp.js` is an [MCP](https://modelcontextprotocol.io) server, so Claude (or any MCP client) can answer questions about the ledger and change it: "how much profit did I make this year?", "add a booking site project for Sweet Crumbs, quoted ₹40,000" (or $500, €300, £250…), "Edustudy paid ₹5,000 today", "mark the GeekBoz website as done". Changes show up on the website the next time it loads.

## Code layout

| File | Role |
|---|---|
| `api/mcp.js` | The endpoint. Checks the OAuth token and hands the tools a per-user database handle |
| `api/_lib/tools.js` | Tool definitions (`TOOLS`), `PROMPTS`, and `INSTRUCTIONS`, the text Claude reads first |
| `api/_lib/ledger.js` | Loads data and computes every number. Read-only |
| `api/_lib/writes.js` | Every change, input cleaning, the `Change` class (logs to `activity_log`) and undo |
| `api/_lib/supabase.js` | The only database access. `forUser(uid)` adds `user_id = uid` to every operation |
| `api/oauth/*`, `api/_lib/oauth.js` | Sign-in for MCP clients (below) |

Every table in the [README](../README.md#data) is reachable through these tools.

## Read tools

| Tool | What it returns |
|---|---|
| `get_summary` | Revenue, spending, profit, margin, still to collect, monthly totals, spending by category, top projects, for any period (including this and last financial year) |
| `compare_periods` | Two periods side by side (this vs last month, this vs last financial year, this vs last year, or any dates) |
| `get_attention_items` | Overdue and soon-due projects and payment milestones, money owed, open leads, projects on hold, missing quotes and links |
| `search` | Clients, projects and money entries containing some text |
| `list_projects` / `get_project` | Projects with client, status, description, links, dates, money and milestones; one project's entries |
| `list_clients` / `get_client` | Clients with totals; one client's projects and entries |
| `list_transactions` | Payments and expenses, filtered by type, dates, client, project or category |
| `list_invoices` / `get_invoice` | Invoices by state (open, overdue, draft, paid, cancelled); one invoice with its lines, payments and UPI link |
| `list_overdue` | Overdue invoices grouped by client, with days overdue and the last reminder |
| `draft_payment_reminder` | The facts for a reminder (amounts, days overdue, tone, WhatsApp number); Claude writes the message, nothing is sent |
| `list_renewals` | Overdue and soon-due renewals, every active service, and yearly revenue, cost and profit from them |
| `list_tasks` | Tasks across projects (open by default), with due dates and what's overdue |
| `list_time` | Hours logged, newest first, with totals per project; filter by project, client or period |
| `get_settings` | Your business details and invoice settings |
| `list_recent_changes` | Changes made through the assistant, and whether they were undone |

## Write tools

| Tool | What it does |
|---|---|
| `create_client` / `update_client` / `delete_client` | Add, edit or delete a client (deleting also removes their projects and money) |
| `create_project` / `update_project` / `delete_project` | Add a project (with a new client if needed), change any field or move it to another client, or delete it |
| `set_milestones` | Replace a project's payment milestones, from a split like `[50, 30, 20]` or a list with amounts and due dates |
| `add_payment` / `add_expense` / `add_transactions` | Log money in or out, one at a time or many at once. A payment can be for an invoice |
| `create_invoice` / `update_invoice` | Invoice a milestone or line items; mark sent, edit, or cancel (never delete) |
| `add_service` / `update_service` / `renew_service` | Track a renewal; edit or stop it; renew it (cost, invoice and next date in one change, two-step) |
| `add_task` / `update_task` / `delete_task` | Add several tasks at once; tick one off, reopen or edit it; delete (two-step) |
| `log_time` | Log minutes or hours on a project |
| `log_reminder` | Record that you reminded a client, so the next reminder is firmer |
| `update_settings` | Change your business details, UPI ID, invoice prefix, payment terms, and your regional settings (default currency, financial year start month, time zone, locale) |
| `update_transaction` / `delete_transactions` | Fix or remove money entries |
| `undo_change` | Revert the latest change, or any earlier one by its `change_id` |

## Currencies, financial year and time zone

- **Currencies.** A fixed list: INR, USD, EUR, GBP, AUD, CAD, SGD, AED, NZD, CHF, JPY, ZAR. Each project has one currency (`currency` on `create_project`; it defaults to the user's default currency), and its payments, expenses, invoices and renewals are always in that currency. Money without a project takes the `currency` given, else the default. There is no conversion.
- **Never added together.** The tools that total money (`get_summary`, `compare_periods`, `list_clients`, `get_client`, `list_transactions`, `list_invoices`, `list_overdue`, `draft_payment_reminder`, `list_renewals`) report one currency at a time: the `currency` input, else the currency of the project/client/invoice being asked about, else the only one in use, else the default. They return `currency`, and `otherCurrencies` (each one's revenue, spending, profit and still to collect) when there is money in others. `get_attention_items`, `list_projects`, `search`, `get_project` and `get_invoice` span all currencies and give every money item its own `currency`.
- **Invariants.** A payment, expense, invoice or renewal in another currency than its project (or a payment than its invoice) is refused, as is moving it to such a project. A project's currency can be changed only while it has no payments, expenses, invoices, renewals or milestones. An invoice's currency never changes.
- **Financial year.** Starts on the first of `fy_start_month` (4 = April, the default; 1 = the calendar year, labelled `FY 2026`). `this_fy` and `last_fy` follow it. Invoice numbers use `PREFIX/2026-27/001` (`PREFIX/2026/001` for a January start); changing the month later restarts the count at 001 under the new label.
- **Time zone.** "Today" (default dates, overdue checks, renewals, invoice dates) is the date in the user's `timezone` setting, default `Asia/Kolkata`.
- **UPI** links and the UPI ID on invoices are only for rupee invoices.

## Prompts

`who_owes_me` and `weekly_review` show up in Claude as ready-made requests.

## Safeguards

- Deletes are two-step: the first call only shows what would be deleted, and nothing happens until it's called again with `confirm: true`.
- A new client is only created when asked for explicitly, so a misspelt name never creates a duplicate.
- Bulk adds are checked first. If any entry doesn't match a client or project, nothing is saved.
- Links must be http(s), dates must be real, amounts must be positive, and money must be in the same currency as its project.
- Every change is recorded in `activity_log` and can be undone as a whole. Writes refuse to run if that table is missing.

## Sign-in (OAuth 2.1)

Connecting an app opens a Client Ledger sign-in page (`/api/oauth/authorize`). Sign in with your own email and password and the app gets a 1-hour access token, renewed with a 30-day refresh token, that only reaches your rows.

The server supports discovery (`/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`), dynamic client registration and PKCE, which is what Claude expects. It stores nothing: registrations, codes and tokens are all signed with `OAUTH_SECRET`.

## Setup

(Vercel → Project → Settings → Environment Variables, then redeploy):

| Variable | Value |
|---|---|
| `SUPABASE_URL` | The Supabase project URL (same as in `config.js`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API keys → the **secret** / `service_role` key. Server-only: never put it in `config.js` |
| `OAUTH_SECRET` | A long random string (at least 32 characters). Changing it signs every connected app out |

Also run `supabase/schema.sql` (see the main [README](../README.md#setup)) so the `activity_log` table exists.

## Connect

- **Claude (web, desktop, mobile):** Settings → Connectors → Add custom connector → `https://<your-site>/api/mcp`, then sign in when asked.
- **Claude Code:** `claude mcp add --transport http client-ledger https://<your-site>/api/mcp`, then `/mcp` to sign in.
