# Client Ledger

My personal web app for running my website development service: every client, every project, and every rupee in or out. Only I can sign in.

**Next steps:** see [`ROADMAP.md`](ROADMAP.md) for the planned features, phase by phase, and the rules for building and testing each one.

**Tests:** `node --test tests/*.test.js` and `node --test tests/e2e/*.test.js`. They run offline against a fake Supabase; see [`tests/README.md`](tests/README.md).

## What it does

- **Dashboard**: revenue, spending, profit and margin for this financial year (April–March, the default), last financial year, this month, the last 12 months, this calendar year or all time; money still to collect; a month-by-month chart of money in and out; most profitable projects; where the money went by category; recent money
- **Projects**: every project as a card with its client, status (Lead, In progress, On hold, Done), description, preview / live / GitHub links, quoted price, how much is paid, spent and profit. Filter by status and search. Or switch to **Board** to see them in columns by status and drag a project (or use its Move to menu) to change its status
- **Project page**: all of the above plus start and due dates and every payment and expense on it
- **Payment milestones**: split a project's price into stages (quick 50/50 or 50/30/20 splits, or your own), each with a due date. The last milestone fills in the rest of the quote and updates as you type the others. Payments cover them in order, so each shows as paid, part paid, not paid yet or overdue, and projects with an overdue milestone show "₹X overdue"
- **Clients**: each client's projects, revenue, profit, contact and notes. A new client can be added on its own or while creating a project
- **Invoices**: numbered invoices (INV/2026-27/001, restarting each financial year) from line items or straight from a milestone, with your business details, a UPI QR code for the amount due, bank details, and Print / Save as PDF on one A4 page. Mark sent, record payments against them (part payments too), cancel. The **Board** view shows them in Draft, Sent, Paid and Cancelled columns: drag a card to move it, and dragging to Paid records the payment. Paid, part paid and overdue are worked out from the payments. No GST or TDS yet
- **Chasing payments**: "To collect on invoices" on the dashboard and the Invoices tab, grouped by client with days overdue. On an overdue invoice, Remind writes a message that gets firmer after 7 and 30 days, to copy or send on WhatsApp yourself, then Mark as reminded
- **Your business details**: name, address, UPI ID, bank details, invoice prefix, payment terms and default notes, printed on invoices
- **Money**: every payment (money in) and expense (money out, with a category like Domain or Hosting), filterable by type, period and text. Tap any entry to edit or delete it
- Email and password sign-in, with password reset

## How it works

A static site with no build step: `index.html` (HTML, CSS and plain JavaScript), `config.js`, and [Supabase](https://supabase.com) for sign-in and data.

| Table | Columns |
|---|---|
| `clients` | `name`, `contact`, `notes`, `sort_order` |
| `projects` | `client_id`, `name`, `status`, `description`, `quoted` (₹), `preview_url`, `live_url`, `github_url`, `start_date`, `due_date` |
| `txns` | `client_id`, `project_id`, `invoice_id`, `type` (`in` / `out`), `amount` (₹), `category`, `note`, `date` |
| `milestones` | `project_id`, `name`, `amount` (₹), `due_date`, `sort_order` |
| `invoices` | `client_id`, `project_id`, `milestone_id`, `number`, `issue_date`, `due_date`, `items` (description, quantity, rate), `total` (₹), `status` (`draft` / `sent` / `paid` / `cancelled`), `notes`, `sent_at`, `last_reminded`, `reminder_count` |
| `settings` | One row: `business_name`, `address`, `phone`, `email`, `upi_id`, `bank_details`, `invoice_prefix`, `payment_terms_days`, `invoice_notes` |

Every table also has `id`, `user_id` and `created_at`. Row-level security lets each signed-in user see and change only their own rows, and sign-ups are turned off, so my account is the only one.

## Setup

1. In Supabase, run `supabase/schema.sql` in the SQL editor. Run it again after updating the app: it only adds what's missing and keeps your data.
2. Authentication → Sign In / Providers: turn **off** "Allow new users to sign up".
3. Authentication → Users → Add user: create my account with email and password.
4. Authentication → URL Configuration: set the Site URL to where the app is hosted.
5. Put the project URL and anon key in `config.js` (never the service_role key).
6. Host the folder anywhere static, such as Vercel.

## Ask AI about my projects (MCP server)

`api/mcp.js` is an [MCP](https://modelcontextprotocol.io) server, so Claude (or any MCP client) can answer questions about the ledger and change it: "how much profit did I make this year?", "add a booking site project for Sweet Crumbs, quoted ₹40,000", "Edustudy paid ₹5,000 today", "mark the GeekBoz website as done". Changes show up on the website the next time it loads.

**Read tools**

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
| `get_settings` | Your business details and invoice settings |
| `list_recent_changes` | Changes made through the assistant, and whether they were undone |

**Write tools**

| Tool | What it does |
|---|---|
| `create_client` / `update_client` / `delete_client` | Add, edit or delete a client (deleting also removes their projects and money) |
| `create_project` / `update_project` / `delete_project` | Add a project (with a new client if needed), change any field or move it to another client, or delete it |
| `set_milestones` | Replace a project's payment milestones, from a split like `[50, 30, 20]` or a list with amounts and due dates |
| `add_payment` / `add_expense` / `add_transactions` | Log money in or out, one at a time or many at once. A payment can be for an invoice |
| `create_invoice` / `update_invoice` | Invoice a milestone or line items; mark sent, edit, or cancel (never delete) |
| `log_reminder` | Record that you reminded a client, so the next reminder is firmer |
| `update_settings` | Change your business details, UPI ID, invoice prefix and payment terms |
| `update_transaction` / `delete_transactions` | Fix or remove money entries |
| `undo_change` | Revert the latest change, or any earlier one by its `change_id` |

**Prompts**: `who_owes_me` and `weekly_review` show up in Claude as ready-made requests.

**Safeguards**

- Deletes are two-step: the first call only shows what would be deleted, and nothing happens until it's called again with `confirm: true`.
- A new client is only created when asked for explicitly, so a misspelt name never creates a duplicate.
- Bulk adds are checked first. If any entry doesn't match a client or project, nothing is saved.
- Links must be http(s), dates must be real, and amounts must be positive.
- Every change is recorded in `activity_log` and can be undone as a whole. Writes refuse to run if that table is missing.

**Sign-in (OAuth 2.1)**

Connecting an app opens a Client Ledger sign-in page (`/api/oauth/authorize`). Sign in with your own email and password and the app gets a 1-hour access token, renewed with a 30-day refresh token, that only reaches your rows.

The server supports discovery (`/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`), dynamic client registration and PKCE, which is what Claude expects. It stores nothing: registrations, codes and tokens are all signed with `OAUTH_SECRET`.

**Setup** (Vercel → Project → Settings → Environment Variables, then redeploy):

| Variable | Value |
|---|---|
| `SUPABASE_URL` | The Supabase project URL (same as in `config.js`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API keys → the **secret** / `service_role` key. Server-only: never put it in `config.js` |
| `OAUTH_SECRET` | A long random string (at least 32 characters). Changing it signs every connected app out |

Also run `supabase/schema.sql` again so the `activity_log` table exists.

**Connect**

- **Claude (web, desktop, mobile):** Settings → Connectors → Add custom connector → `https://<your-site>/api/mcp`, then sign in when asked.
- **Claude Code:** `claude mcp add --transport http client-ledger https://<your-site>/api/mcp`, then `/mcp` to sign in.
