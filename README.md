# Client Ledger

My personal web app for running my website development service: every client, every project, and every rupee in or out.

## What it does

- Shows total profit, money in, money out, and this month's profit
- Lists clients with their projects and profit per client
- Logs payments (money in) and expenses like domains (money out), each tied to a client and project
- Lets me add clients and projects, and delete entries

## How it works

`index.html` is a single self-contained page: HTML, CSS and plain JavaScript, no build step.

It runs as a Claude artifact on claude.ai and stores its data with the artifact's built-in database (`window.claude.use("db")`), in three collections:

| Collection | Fields |
|---|---|
| `clients` | `name`, `contact`, `createdAt`, `order` |
| `projects` | `clientId`, `name`, `createdAt` |
| `txns` | `clientId`, `projectId`, `type` (`in` / `out`), `amount` (₹), `note`, `date` (YYYY-MM-DD), `createdAt` |

Access rules make the data readable and writable only by the owner.

The data itself is not stored in this repo. Opened outside claude.ai, the page loads but can't reach the database. Running it on my own domain means swapping the `db` calls for a backend such as Firebase or Supabase.
