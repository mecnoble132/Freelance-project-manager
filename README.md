# Client Ledger

A personal web app for running a freelance web-development business: every client, project, invoice, renewal and rupee in or out, in one place. It is built for a single owner (sign-ups are turned off), works on phone and desktop, and can be driven from Claude through a built-in [MCP server](docs/mcp.md).

All money is in Indian rupees (INR) and dates are `YYYY-MM-DD` in India time. The financial year runs April to March.

## Contents

- [Features](#features)
- [Architecture](#architecture)
- [Data](#data)
- [Setup](#setup)
- [Ask Claude about your projects](#ask-claude-about-your-projects)
- [Tests](#tests)
- [Contributing](#contributing)

## Features

- **Dashboard**: revenue, spending, profit and margin for this financial year (April–March, the default), last financial year, this month, the last 12 months, this calendar year or all time; money still to collect; a month-by-month chart of money in and out; most profitable projects; where the money went by category; recent money
- **Projects**: every project as a card with its client, status (Lead, In progress, On hold, Done), description, preview / live / GitHub links, quoted price, how much is paid, spent and profit. Filter by status and search. Or switch to **Board** to see them in columns by status and drag a project (or use its Move to menu) to change its status
- **Project page**: all of the above plus start and due dates and every payment and expense on it
- **Payment milestones**: split a project's price into stages (quick 50/50 or 50/30/20 splits, or your own), each with a due date. The last milestone fills in the rest of the quote and updates as you type the others. Payments cover them in order, so each shows as paid, part paid, not paid yet or overdue, and projects with an overdue milestone show "₹X overdue"
- **Clients**: each client's projects, revenue, profit, contact and notes. A new client can be added on its own or while creating a project
- **Invoices**: numbered invoices (INV/2026-27/001, restarting each financial year) from line items or straight from a milestone, with your business details, a UPI QR code for the amount due, bank details, and Print / Save as PDF on one A4 page. Mark sent, record payments against them (part payments too), cancel. The **Board** view shows them in Draft, Sent, Paid and Cancelled columns: drag a card to move it, and dragging to Paid records the payment. Paid, part paid and overdue are worked out from the payments. No GST or TDS yet
- **Chasing payments**: "To collect on invoices" on the dashboard and the Invoices tab, grouped by client with days overdue. On an overdue invoice, Remind writes a message that gets firmer after 7 and 30 days, to copy or send on WhatsApp yourself, then Mark as reminded
- **Renewals**: the domains, hosting, SSL, care plans and email you renew for clients, with what each costs you and what you charge, monthly, quarterly or yearly. The dashboard shows what renews in the next 30 days (overdue in red); the Renewals page shows yearly revenue, cost and profit; each client's page lists their services. **Renew** shows what it will do, then logs your cost, creates a draft invoice and moves the date on one cycle
- **Tasks and time**: each project has a checklist (tick tasks off, give them due dates) and a Time card where you log hours (`1h 30m`, `45m` or `1.5h`). Once time is logged the project shows **Earned per hour** (money received ÷ hours). The dashboard lists tasks overdue or due in the next 7 days. Deleting a project deletes its tasks and time.
- **Your business details**: name, address, UPI ID, bank details, invoice prefix, payment terms and default notes, printed on invoices
- **Money**: every payment (money in) and expense (money out, with a category like Domain or Hosting), filterable by type, period and text. Tap any entry to edit or delete it
- Email and password sign-in, with password reset

## Architecture

A static site with no build step, backed by [Supabase](https://supabase.com) for sign-in and data, plus an MCP server on Vercel.

```
Browser (index.html + config.js) --supabase-js--> Supabase (Postgres + auth, row-level security)
Claude / MCP client --OAuth--> api/mcp.js (Vercel function) --service key, always filtered by user_id--> Supabase
```

- **Website:** `index.html` (HTML, CSS, plain JavaScript, no build step) and `config.js`. It talks to Supabase from the browser; row-level security keeps each user to their own rows.
- **Database:** `supabase/schema.sql` is the whole schema and is safe to run again.
- **MCP server:** `api/`, deployed as Vercel functions. See [docs/mcp.md](docs/mcp.md).
- **Tests:** `tests/`, run offline against a fake Supabase.

## Data

| Table | Columns |
|---|---|
| `clients` | `name`, `contact`, `notes`, `sort_order` |
| `projects` | `client_id`, `name`, `status`, `description`, `quoted` (₹), `preview_url`, `live_url`, `github_url`, `start_date`, `due_date` |
| `txns` | `client_id`, `project_id`, `invoice_id`, `type` (`in` / `out`), `amount` (₹), `category`, `note`, `date` |
| `milestones` | `project_id`, `name`, `amount` (₹), `due_date`, `sort_order` |
| `invoices` | `client_id`, `project_id`, `milestone_id`, `number`, `issue_date`, `due_date`, `items` (description, quantity, rate), `total` (₹), `status` (`draft` / `sent` / `paid` / `cancelled`), `notes`, `sent_at`, `last_reminded`, `reminder_count` |
| `services` | `client_id`, `project_id`, `kind` (domain, hosting, ssl, maintenance, email, other), `name`, `provider`, `cost` and `price` (₹ each cycle), `cycle` (monthly / quarterly / yearly), `next_renewal`, `auto_renew`, `active`, `notes` |
| `tasks` | `project_id`, `title`, `done`, `due_date`, `sort_order`, `done_at` |
| `time_entries` | `project_id`, `date`, `minutes`, `note` |
| `activity_log` | Changes made through Claude (written by the MCP server only), kept so they can be undone |
| `settings` | One row: `business_name`, `address`, `phone`, `email`, `upi_id`, `bank_details`, `invoice_prefix`, `payment_terms_days`, `invoice_notes` |

Every table also has `id`, `user_id` and `created_at`. Row-level security lets each signed-in user see and change only their own rows, and sign-ups are turned off, so the owner's account is the only one.

## Setup

1. In Supabase, run `supabase/schema.sql` in the SQL editor. Run it again after updating the app: it only adds what's missing and keeps your data.
2. Authentication → Sign In / Providers: turn **off** "Allow new users to sign up".
3. Authentication → Users → Add user: create the owner's account with email and password.
4. Authentication → URL Configuration: set the Site URL to where the app is hosted.
5. Put the project URL and anon key in `config.js` (never the service_role key).
6. Host the folder anywhere static, such as Vercel.

## Ask Claude about your projects

The ledger includes an MCP server, so Claude can answer questions ("how much profit did I make this year?", "who owes me money?") and make changes ("Edustudy paid ₹5,000 today") with every change undoable and every delete confirmed first. It has 42 tools and two ready-made prompts, `who_owes_me` and `weekly_review`.

To connect, set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `OAUTH_SECRET` in Vercel, then add `https://<your-site>/api/mcp` as a custom connector in Claude. Full tool list, safeguards, sign-in details and setup are in [docs/mcp.md](docs/mcp.md).

## Tests

```sh
node --test tests/*.test.js        # server, database and consistency tests (Node 22, nothing to install)
node --test tests/e2e/*.test.js    # the website in a real browser (needs Playwright)
```

They run offline against a fake Supabase, and GitHub runs them on every pull request and every push to `main`. See [tests/README.md](tests/README.md).

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the rules (database changes only add, how to add a feature, what not to do) and the list of what has been built and what is planned.
