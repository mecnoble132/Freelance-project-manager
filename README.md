# Client Ledger

My personal web app for running my website development service: every client, every project, and every rupee in or out. Only I can sign in.

## What it does

- Shows total profit, money in, money out, and this month's profit
- Lists clients with their projects and profit per client
- Logs payments (money in) and expenses like domains (money out), each tied to a client and project
- Lets me add clients and projects, and delete entries
- Email and password sign-in, with password reset

## How it works

A static site with no build step: `index.html` (HTML, CSS and plain JavaScript), `config.js`, and [Supabase](https://supabase.com) for sign-in and data.

| Table | Columns |
|---|---|
| `clients` | `name`, `contact`, `sort_order` |
| `projects` | `client_id`, `name` |
| `txns` | `client_id`, `project_id`, `type` (`in` / `out`), `amount` (₹), `note`, `date` |

Every table also has `id`, `user_id` and `created_at`. Row-level security lets each signed-in user see and change only their own rows, and sign-ups are turned off, so my account is the only one.

## Setup

1. In Supabase, run `supabase/schema.sql` in the SQL editor.
2. Authentication → Sign In / Providers: turn **off** "Allow new users to sign up".
3. Authentication → Users → Add user: create my account with email and password.
4. Authentication → URL Configuration: set the Site URL to where the app is hosted.
5. Put the project URL and anon key in `config.js` (never the service_role key).
6. Host the folder anywhere static, such as Vercel.
