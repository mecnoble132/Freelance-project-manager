# Tests

Everything runs offline against a fake Supabase, so no Supabase project, keys or network are needed, and real data is never touched.

```sh
node --test tests/*.test.js        # server, database and consistency tests (Node 22, nothing to install)
node --test tests/e2e/*.test.js    # the website in a real browser (needs Playwright, below)
```

Website tests need Playwright once: `npm ci --prefix tests/e2e && npx --prefix tests/e2e playwright install chromium`. Claude Code's cloud environment already has it.

GitHub runs both on every pull request and every push to `main` (`.github/workflows/tests.yml`). Don't merge when it's red.

## What's covered

| File | What it checks |
|---|---|
| `ledger.test.js` | Every number the MCP read tools report: periods (including financial years), totals, still to collect, milestone states, attention items, finding clients and projects by name |
| `invoices.test.js` | Invoice states from linked payments, numbering across 1 April, the UPI link, overdue lists and reminder facts |
| `tasks.test.js` | Tasks and time: earned per hour (and none without time), overdue tasks, adding, ticking off and deleting tasks, logging time, deleting a project or client with undo |
| `renewals.test.js` | Renewal dates for each cycle (31 Jan, 29 Feb), what's due and overdue, and yearly profit |
| `writes.test.js` | Every change tool: what it saves, what it refuses, two-step deletes, and that `undo_change` puts the data back exactly |
| `tools.test.js` | The tool list is well formed, and every read tool runs on a full and an empty ledger without changing anything |
| `oauth.test.js` | Connecting from Claude end to end: discovery, registration, the sign-in page, PKCE, refresh, expiry, then calling tools |
| `consistency.test.js` | Facts repeated across files still match (statuses, categories, tables, undo lists), `schema.sql` is safe to rerun and only adds things, every table has row-level security, and only `api/_lib/supabase.js` touches the database |
| `e2e/website.test.js` | The website in Chromium: sign-in, dashboard numbers, adding and editing projects, clients and money, deleting, filters, and phone-width layout in light and dark mode |

## How it works

- `helpers/schema.js` reads `supabase/schema.sql`. `helpers/store.js` is an in-memory database built from it, with the same columns, defaults, allowed values and foreign keys (cascade / set null). Writing a column that isn't in the schema fails, just like the real database.
- `helpers/fake-supabase.js` replaces `fetch` for the server tests, so `api/_lib/supabase.js` runs unchanged. Any request without a `user_id` filter fails the test, because the service key skips row-level security.
- `e2e/fake-supabase-js.js` replaces the supabase-js library in the browser, with the same store and the signed-in user's rows only.
- `helpers/seed.js` is the test ledger, with its key numbers written at the top, plus a second user whose data must never appear or change. "Today" is fixed at 2026-10-23 in India.

## When you add a feature

1. Add the new table or columns to `schema.sql`. The fakes pick them up automatically.
2. Add seed rows for it in `helpers/seed.js` if the feature needs data to show.
3. Tests for every calculation (in `ledger.test.js` or a new file), and every new change tool through `changeAndUndo()` in `writes.test.js`.
4. A website test for each new screen or button in `e2e/website.test.js`, and add any new page to the phone-width test.
5. If you add a new list that's repeated across files, add a check for it to `consistency.test.js`.
