# Client Ledger

My personal web app for running my website development service: every client, every project, and every rupee in or out. Only I can sign in.

## What it does

- **Dashboard**: revenue, spending, profit and margin for this month, the last 12 months, this year or all time; money still to collect; a month-by-month chart of money in and out; most profitable projects; where the money went by category; recent money
- **Projects**: every project as a card with its client, status (Lead, In progress, On hold, Done), description, preview / live / GitHub links, quoted price, how much is paid, spent and profit. Filter by status and search
- **Project page**: all of the above plus start and due dates and every payment and expense on it
- **Clients**: each client's projects, revenue, profit, contact and notes. A new client can be added on its own or while creating a project
- **Money**: every payment (money in) and expense (money out, with a category like Domain or Hosting), filterable by type, period and text. Tap any entry to edit or delete it
- Email and password sign-in, with password reset

## How it works

A static site with no build step: `index.html` (HTML, CSS and plain JavaScript), `config.js`, and [Supabase](https://supabase.com) for sign-in and data.

| Table | Columns |
|---|---|
| `clients` | `name`, `contact`, `notes`, `sort_order` |
| `projects` | `client_id`, `name`, `status`, `description`, `quoted` (₹), `preview_url`, `live_url`, `github_url`, `start_date`, `due_date` |
| `txns` | `client_id`, `project_id`, `type` (`in` / `out`), `amount` (₹), `category`, `note`, `date` |

Every table also has `id`, `user_id` and `created_at`. Row-level security lets each signed-in user see and change only their own rows, and sign-ups are turned off, so my account is the only one.

## Setup

1. In Supabase, run `supabase/schema.sql` in the SQL editor. Run it again after updating the app: it only adds what's missing and keeps your data.
2. Authentication → Sign In / Providers: turn **off** "Allow new users to sign up".
3. Authentication → Users → Add user: create my account with email and password.
4. Authentication → URL Configuration: set the Site URL to where the app is hosted.
5. Put the project URL and anon key in `config.js` (never the service_role key).
6. Host the folder anywhere static, such as Vercel.

## Ask AI about my projects (MCP server)

`api/mcp/[key].js` is a read-only [MCP](https://modelcontextprotocol.io) server, so Claude (or any MCP client) can answer questions like "how much profit did I make this year?", "what does GeekBoz still owe me?" or "what's the live link for the Edustudy website?" from the ledger.

| Tool | What it returns |
|---|---|
| `get_summary` | Revenue, spending, profit, margin, still to collect, monthly totals, spending by category, top projects, for any period |
| `list_projects` / `get_project` | Projects with client, status, description, links, dates and money; one project's payments and expenses |
| `list_clients` / `get_client` | Clients with totals; one client's projects and money |
| `list_transactions` | Payments and expenses, filtered by type, dates, client, project or category |

It can only read, never change anything.

**Setup** (Vercel → Project → Settings → Environment Variables, then redeploy):

| Variable | Value |
|---|---|
| `SUPABASE_URL` | The Supabase project URL (same as in `config.js`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API keys → the **secret** / `service_role` key. Server-only: never put it in `config.js` |
| `MCP_SECRET` | A long random string (at least 24 characters). It is part of the server's address, so treat it like a password |

The server's address is `https://<your-site>/api/mcp/<MCP_SECRET>`. Any other address returns 404.

- **Claude (web, desktop, mobile):** Settings → Connectors → Add custom connector, paste the address.
- **Claude Code:** `claude mcp add --transport http client-ledger https://<your-site>/api/mcp/<MCP_SECRET>`
