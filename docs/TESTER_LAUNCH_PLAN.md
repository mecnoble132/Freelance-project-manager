# Plan: open Client Ledger to 5 outside testers

This document is written so that a developer, or a Claude instance, who has never seen this project can do the work from it. Read sections 1 to 4 completely before touching any code. Sections 5 to 7 say what to build; section 8 is the step-by-step work, in order; sections 9 to 11 cover testing, releasing and what the owner must do.

## 0. Progress (update this as you go)

Tick a step only when its "Done when" list is true, its tests pass and the full suite is green. Add one line to the log at the bottom.

| Step | What | Status |
|---|---|---|
| 1 | Database changes in `supabase/schema.sql` | not started |
| 2 | Server (MCP) understands currency, financial year, time zone | not started |
| 3 | Website: currency, financial year, time zone, and the full Settings page | not started |
| 4 | Invite-only sign-up and the first-run screen | not started |
| 5 | Sample data (load and remove) | not started |
| 6 | Cross-user safety tests and live database checks | not started |
| 7 | Account deletion, data export, privacy page, feedback link, error handler | not started |
| 8 | Documentation | not started |
| 9 | Dry run on the live site | not started |

---

## 1. The goal, in plain words

Client Ledger is a personal app the owner built to run their freelance web-development business: clients, projects, payments, expenses, invoices, renewals (domains, hosting), tasks and time. Today it has exactly one user (the owner), sign-ups are switched off, and it assumes Indian rupees, India time and the Indian financial year (April to March).

The owner wants to give it to **five outside testers** (freelance web developers recruited on Reddit, some in India, some elsewhere) to find out whether anyone else wants it. This plan gets the app to the point where those five people can:

1. sign up themselves (but only if the owner invited their email),
2. choose their own currency, financial year start and time zone,
3. see a populated dashboard straight away using a temporary "load sample data" button,
4. use every existing feature with their own data, in their own currency,
5. connect Claude to their own ledger (the app has an MCP server for this),
6. never be able to see or change anyone else's data,
7. tell the owner what is wrong.

Not in this round: billing, teams/agencies, tax (GST, TDS, VAT), currency conversion, other languages, a marketing site (full list in section 11).

**The owner's own account must behave exactly as it does today after every step** (rupees, April financial year, India time). The existing tests protect this; do not weaken or delete them to make a change pass.

## 2. How the project works (read this before coding)

### 2.1 Architecture

```
Browser: index.html + config.js ──supabase-js (anon key)──▶ Supabase (Postgres + Auth, row-level security)
Claude / MCP client ──OAuth──▶ api/mcp.js (Vercel function) ──service key, every query filtered by user_id──▶ Supabase
```

- **The website** is one file, `index.html` (about 1,550 lines of HTML, CSS and plain JavaScript) plus `config.js`. There is **no build step, no framework and no npm packages for the site**; do not add any. It talks to Supabase directly from the browser; Supabase row-level security (RLS) keeps each signed-in user to their own rows.
- **The database** is Supabase Postgres. `supabase/schema.sql` is the entire schema. It is written to be run again and again safely.
- **The MCP server** (so Claude can read and change the ledger) lives in `api/` as Vercel serverless functions. It uses Supabase's **service key**, which **bypasses RLS**, so every query is filtered by `user_id` by hand. That filtering is done in exactly one place, `forUser(uid)` in `api/_lib/supabase.js`. A test fails if any other file talks to the database or if a request lacks a `user_id` filter.
- **Hosting** is Vercel (`vercel.json` only holds OAuth URL rewrites). Environment variables on Vercel: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OAUTH_SECRET`. Never print them, never put the service key anywhere else, never change `OAUTH_SECRET` (it signs every connected Claude app out).
- The live Supabase project is called `client-ledger` (the project URL is in `config.js`; the anon key there is public by design).

### 2.2 File map

| File | What it is |
|---|---|
| `index.html` | The whole website. Helpers: `h()` builds elements, `sheet()` opens a pop-up form, `confirmSheet()`, `toast()`. `S` is the global state (`S.clients`, `S.projects`, `S.txns`, `S.milestones`, `S.invoices`, `S.settings`, `S.services`, `S.tasks`, `S.time_entries`). `api.insert/update/del` change the screen immediately and save in the background. `parseHash()` / `hrefOf()` / `go()` do routing on the URL hash (`#/projects`, `#/invoice/<id>`). `render()` has a map from view name to a `render…` function. `map` converts database rows to objects; `TABLES`, `OPTIONAL`, `ON_DELETE` list tables and delete rules. `renderLogin()` is the sign-in screen. `openSettingsSheet()` is today's settings pop-up. Money formatting is `rs()`; dates are `today()` / `fmtDate()`; financial year logic is `fyStart()`, `fyLabel()`, `fyRange()`, `PERIODS`, `periodBuckets()`, `inPeriod()`; invoice numbers are `nextInvoiceNumber()`; the UPI payment link is `upiLink()`. |
| `config.js` | Supabase URL and anon key. Will also hold small feature flags (section 5.6). |
| `supabase/schema.sql` | All tables, columns, constraints, indexes and RLS policies. |
| `api/mcp.js` | The MCP endpoint (JSON-RPC over HTTP). |
| `api/oauth/*.js`, `api/_lib/oauth.js` | OAuth 2.1 so Claude can connect. Tokens are signed with `OAUTH_SECRET`, no database. `authorize.js` shows the sign-in page where a user logs in and allows access. |
| `api/_lib/supabase.js` | The only code that talks to the database: `forUser(uid)` (select/insert/update/remove, always filtered by `user_id`), `signIn(email, password)`, and an account-exists check. |
| `api/_lib/ledger.js` | Read side. `load(db)` fetches everything for one user into a `Ledger` object. Date helpers (`todayIST`, `periodRange`, `fyRange`, `fyLabel`, `fyOf`), `sumOf`, `nextInvoiceNumber`, and the calculations behind every read tool (summary, overdue, attention items, renewals, tasks and time). |
| `api/_lib/writes.js` | Write side. Input checking (`money`, `date`, `text`, `fail`), the `Change` class (logs every write to `activity_log` so it can be undone), and one function per write tool. |
| `api/_lib/tools.js` | The MCP tool list: names, descriptions and input schemas that Claude sees, plus `INSTRUCTIONS` (a prompt describing the product) and `PROMPTS`. |
| `docs/mcp.md` | Human documentation of the MCP server. |
| `tests/` | Offline tests; see 2.5. |
| `README.md`, `CONTRIBUTING.md` | Product description and the rules for changing the code. **Read `CONTRIBUTING.md` fully; its rules apply to every step below.** |

### 2.3 Data model

Every table has `id`, `user_id` (default `auth.uid()`, references `auth.users` with `on delete cascade`) and `created_at`, an index on `user_id`, RLS enabled and an "own rows" policy (`user_id = (select auth.uid())`).

| Table | Key columns | Points at |
|---|---|---|
| `clients` | `name`, `contact`, `notes`, `sort_order` | |
| `projects` | `name`, `status` (lead/active/paused/done), `description`, `quoted`, links, `start_date`, `due_date` | `client_id` (cascade) |
| `txns` | `type` (`in` = payment, `out` = expense), `amount`, `category`, `note`, `date` | `client_id` (cascade), `project_id` (**set null** when the project is deleted), `invoice_id` (set null) |
| `milestones` | `name`, `amount`, `due_date`, `sort_order` | `project_id` (cascade) |
| `invoices` | `number`, `issue_date`, `due_date`, `items` (json), `total`, `status` (draft/sent/paid/cancelled), reminder fields | `client_id` (cascade), `project_id` (set null), `milestone_id` (set null) |
| `services` | renewals: `kind`, `name`, `provider`, `cost`, `price`, `cycle`, `next_renewal`, `auto_renew`, `active` | `client_id` (cascade), `project_id` (set null) |
| `tasks`, `time_entries` | checklist and logged minutes | `project_id` (cascade) |
| `settings` | one row per user (unique index on `user_id`): business name, address, phone, email, `upi_id`, `bank_details`, `invoice_prefix`, `payment_terms_days`, `invoice_notes` | |
| `activity_log` | every change made through Claude, so it can be undone; its `table_name` check lists every table the MCP server may change | |

Invoice numbers look like `INV/2026-27/001`, restart each financial year, are unique per user and are never reused (invoices are cancelled, never deleted).

### 2.4 Rules that apply to every step (from `CONTRIBUTING.md`; read the original too)

- **Database changes only add.** Never drop or rename columns or tables. New columns need a default or must be nullable. Use `if not exists` / `drop … if exists` so the file stays re-runnable, copying the existing style.
- New tables copy the existing shape (id, user_id, created_at, user index, RLS, "own rows" policy) and **must be added to the `activity_log` check list** if the MCP server will change them. Tables the website reads must be added to `TABLES`, `map` and (if other rows point at them) `ON_DELETE`; a missing optional table must load as an empty list, never break the app.
- Money is `numeric(12, 2)`, dates are `date` / `YYYY-MM-DD` strings.
- Website: match the existing code style (`h()`, `sheet()`, `api.*`), short comments, plain-words labels. New pages: add the name to `parseHash()` and a `render…` function to the map in `render()`. Check new screens at phone width in light and dark mode.
- MCP: all database access through `forUser()`. Write tools follow the existing pattern (`load` → clean inputs with `fail()` → `new Change(db, summary)` → `ch.ready()` → `ch.insert/update/remove` → `return done(…)`). Deletes are two-step (`confirmFirst`). Update `INSTRUCTIONS` and `docs/mcp.md` when behaviour changes.
- Lists that are repeated in several files (project statuses, expense categories, periods, tables) are kept in sync by tests in `tests/consistency.test.js`. The new currency list (section 5.1) must get the same treatment.
- **Every feature ships with its tests.** See `tests/README.md` "When you add a feature".
- Don't: add a build step/framework/npm packages to the site; drop or rename columns; change OAuth code without testing a fresh connection; log tokens or passwords; send emails or messages from the server (Supabase sends the sign-up and reset emails itself).

### 2.5 Running the tests (Node 22, nothing to install for the first command)

```sh
node --test tests/*.test.js        # server, database and consistency tests
node --test tests/e2e/*.test.js    # the website in a real browser (Chromium via Playwright)
```

First time only for the website tests: `npm ci --prefix tests/e2e && npx --prefix tests/e2e playwright install chromium` (Claude Code cloud sessions already have Chromium; do not run `playwright install` there).

How the tests work, in brief:

- Everything runs offline against a **fake Supabase**. `tests/helpers/schema.js` parses `supabase/schema.sql`; `tests/helpers/store.js` is an in-memory database built from it (same columns, defaults, allowed values, foreign keys). Writing a column that is not in the schema fails, like the real database. Any server request without a `user_id` filter fails the test.
- `tests/helpers/seed.js` is the test ledger. Its header comment lists the key numbers. "Today" is fixed at **2026-10-23, India time**. It also contains a **second user (`OTHER`) whose data must never appear or change**.
- `tests/e2e/fake-supabase-js.js` replaces the Supabase browser library with the same store, limited to the signed-in user. `tests/e2e/website.test.js` has an `open()` helper that starts Chromium on the site with a fixed clock, India time zone and `en-IN` locale; you will need to extend it to open the site with other time zones, locales, users and empty ledgers.
- The fake database does **not** run SQL functions or triggers. The sign-up gate (step 4) therefore cannot be tested by the fake store; see step 4 for how to test it.
- GitHub Actions (`.github/workflows/tests.yml`) runs both commands on every pull request and push to `main`.

### 2.6 Working agreement

- Develop on the branch `claude/multi-tenant-saas-conversion-2q210b`. Commit in small steps with clear messages. Push to that branch. **Do not open a pull request or merge unless the owner asks.**
- Keep the whole suite green after every step. Do not skip, delete or loosen a test to get green; if an old test must change because behaviour intentionally changed, change it narrowly and say why in the commit message.
- When you finish a step, tick it in section 0, add a line to the log (section 12), and note anything you found that the next person needs to know.
- Anything that touches the **live** database or live site follows section 10.

### 2.7 Glossary

- **Tenant / user**: one signed-in person; their rows are identified by `user_id`.
- **Allow-list**: the table of emails that may create an account (step 4).
- **FY**: financial year, starting on the user's chosen month (default April).
- **MCP**: the protocol that lets Claude call the ledger's tools. "Claude tools" = the tools listed in `api/_lib/tools.js`.
- **Sheet**: the pop-up form component in the website.
- **Service key**: the Supabase key that bypasses RLS; server-only.

---

## 3. Decisions (already made by the owner; do not re-open them)

| Question | Decision |
|---|---|
| How do testers get in? | A tester tells the owner their email. The owner adds it to an allow-list. The tester then **signs up on their own** with that email. Any email not on the list is refused. |
| Where does it run? | The **same** Supabase and Vercel project as the owner's real data. No separate staging copy. The owner accepts the risk to their own data; still follow the "only add" database rule. |
| Language and tax | English only. No GST, TDS or any tax feature. |
| Currency | A **fixed list** of currencies. **Each project has exactly one currency**; different projects may use different currencies. No conversion between currencies. |
| Financial year | A per-user setting (start month), changed on the Settings page. |
| Time zone | A per-user setting. |
| Settings | One **full Settings page per user** (`#/settings`), replacing today's "Your business details" pop-up. Projects do **not** get a settings page; a project's only own setting is its currency, in the Edit project form. |
| Sample data | A **temporary** button that fills an empty dashboard with dummy data, and another that removes it. |
| Who are the testers | Solo freelance web developers. Marketing/web agencies are not a target. |

---

## 4. The one design point that needs care: currency

**Each money-carrying row stores its own currency**, and the rules below keep it consistent. (An earlier draft derived currency from the project only. That is unsafe: `txns`, `invoices` and `services` use `project_id … on delete set null`, so deleting a project would silently re-label its payments and invoices with the user's default currency.)

New column `currency text not null default 'INR'` with a `check` against the fixed list, on:

- `projects`
- `txns` (payments and expenses)
- `invoices`
- `services`

`milestones` do not get one: they belong to a project (cascade delete) and use its currency. `settings.default_currency` (section 5.2) is used only when something is created without a project.

Invariants (enforce in the website forms **and** in the MCP write tools, with clear error messages; add a consistency test where possible):

1. A row with a `project_id` has the **same currency as that project**. When a project is chosen in a form, the currency field is filled from it and disabled.
2. A row without a project takes the currency the user picks, defaulting to their `default_currency`.
3. A payment linked to an invoice (`txns.invoice_id`) has the same currency as the invoice. An invoice's currency never changes after creation.
4. A **project's currency can be changed only while nothing is attached to it** (no txns, invoices, services, milestones). Otherwise the form shows it read-only with a short explanation.
5. Moving a payment/expense/invoice/service to a project in another currency is refused ("That project is in USD; this payment is in INR").
6. Existing rows get `INR` from the column default, so the owner's data does not change meaning.

Aggregation rules:

- **Never add amounts in different currencies.** Every total (revenue, spending, profit, margin, still to collect, overdue, month-by-month chart, category breakdown, most-profitable projects, renewals' yearly revenue/cost/profit) is calculated **per currency**.
- Website dashboard: shows one currency at a time, starting with the user's default currency. A small currency switcher appears only when the user has money in more than one currency (remember the choice with `setPref`). A user with a single currency sees no change from today.
- Lists (projects, money, invoices, a client page, renewals) show every amount in its own currency. Where the site shows a total over a list that mixes currencies, show one subtotal per currency.
- MCP read tools get an optional `currency` input (default: the user's default currency) and return figures for that currency, with a `currency` field in the result and a short `other_currencies` list (currency plus its revenue, spending, profit and still-to-collect) when the user has money in more than one. For a single-currency user the result shape stays as it is today plus the `currency` field, so existing tests keep passing.
- MCP write tools: `create_project` and `update_project` take an optional `currency`; payment, expense, invoice and renewal tools take their currency from the project, or an optional `currency` when there is no project. Tool descriptions that say "rupees" or "India time" must be reworded (find them with the grep in step 2).

---

## 5. What to build (specification)

### 5.1 The fixed currency list

`INR, USD, EUR, GBP, AUD, CAD, SGD, AED, NZD, CHF, JPY, ZAR`

One list, written in three places that a consistency test keeps identical: `supabase/schema.sql` (check constraints), `api/_lib/ledger.js` (exported `CURRENCIES`) and `index.html`. Adding a currency later means editing those three and running the test.

Formatting: use `Intl.NumberFormat(locale, { style: 'currency', currency })`. Dashboards and lists show whole units (as `rs()` does today); forms, invoices and receipts show exact amounts (JPY has no decimals). Replace `rs()` and every hard-coded `₹` / `toLocaleString('en-IN')` / `en-IN` in `index.html`, `writes.js` and `ledger.js` messages with a formatter that takes the amount's currency.

### 5.2 New per-user settings

New columns on `settings` (all with defaults that reproduce today's behaviour; the row may not exist for a brand-new user, in which case the same defaults apply in code):

| Column | Meaning | Default |
|---|---|---|
| `default_currency` | currency for new projects and project-less money | `INR` |
| `fy_start_month` | 1 to 12 | `4` |
| `timezone` | IANA name such as `Asia/Kolkata`, `America/New_York` | `Asia/Kolkata` |
| `locale` | number/date formatting; one of `en-IN`, `en-US`, `en-GB`, `en-AU`, `en-CA` | `en-IN` |

On first run the website pre-fills time zone from the browser (`Intl.DateTimeFormat().resolvedOptions().timeZone`) and locale from the chosen currency (INR→en-IN, USD→en-US, GBP→en-GB, AUD→en-AU, CAD→en-CA, others→en-GB).

### 5.3 Financial year

- `fy_start_month = 1` means the calendar year, labelled `FY 2026`; any other month gives `FY 2026–27` style labels; April keeps today's exact labels. The range runs from the 1st of the start month to the last day of the month before it.
- Month granularity is deliberate (a UK tax year that starts 6 April is approximated by April); say so in the Settings help text.
- Invoice numbers: `PREFIX/<label>/001` where `<label>` is `2026` (January start) or `2026-27`. The financial year of an invoice comes from its issue date and the user's start month. Existing numbers never change. If a user changes `fy_start_month` later, numbering continues under the new label and restarts at 001; uniqueness is per user and number, so no clashes. Show a one-line warning on the Settings page when it is changed.
- Replace: `fyStart/fyLabel/fyRange/PERIODS` in `index.html`; `fyLabel/fyRange/fyOf/periodRange/nextInvoiceNumber` in `ledger.js`; the second copy of the invoice-number logic in `index.html` (`nextInvoiceNumber`) and the one in `writes.js`; the `this_fy` / `last_fy` descriptions in `tools.js` ("Indian financial years (April to March)").
- The period names `this_fy` / `last_fy` stay (the consistency test requires website and MCP periods to match).

### 5.4 Time zone

"Today" must come from the user's time zone, in the website (`today()`) and on the server (`todayIST()` in `ledger.js` and every use in `writes.js`, e.g. default dates for payments, invoice issue dates, overdue checks, renewals). Replace `todayIST()` with `todayIn(timezone)` and thread the user's time zone from `settings` through `Ledger`. Compute the date with `Intl.DateTimeFormat('en-CA', { timeZone, … })` (which yields `YYYY-MM-DD`), not by adding a fixed offset. Tests must cover a user whose local date differs from the UTC date.

### 5.5 The Settings page (`#/settings`)

Replaces `openSettingsSheet()`, which today is reachable only from the Invoices page ("Your details" button and the setup notice).

- New route: add `settings` to `parseHash()` and the `render()` map. Add a **Settings** link in the top bar next to **Sign out** (not a tab in the main section bar). It must be reachable from every screen.
- Sections, each with its own Save button so a mistake in one does not block the others:
  1. **Business**: business name, address, phone, email (printed on invoices).
  2. **Invoices**: invoice prefix, payment terms (days), notes on every new invoice, bank/payment details; UPI ID shown **only when the default currency is INR**.
  3. **Regional**: default currency, financial-year start month, time zone, locale. Show the effect in words ("Your financial year runs 1 January to 31 December").
  4. **Sample data**: Load / Remove (section 5.7), only while the config flag is on.
  5. **Your data and account**: Download my data, Delete my account, link to the privacy page, feedback link (step 7).
- Keep the existing validations (UPI format, prefix = letters/numbers/dashes up to 10, payment terms 0 to 365 whole days).
- The Invoices page keeps a small "Your details" link and the setup notice, both now going to `#/settings`. No settings pop-up remains.
- Where the UPI QR / link appears on invoices, show it only for INR invoices; other currencies show the bank/payment details text instead. Same on the server (`ledger.js` builds the UPI link with `cu: 'INR'`).

### 5.6 Feature flags and links in `config.js`

```js
window.LEDGER_CONFIG = {
  supabaseUrl: "...", supabaseAnonKey: "...",   // existing
  sampleData: true,                              // shows the sample-data buttons; set false (or delete the feature) before any public launch
  feedbackUrl: "mailto:owner@example.com"        // the owner fills this in
};
```

Code must treat missing flags as "off" / "no link".

### 5.7 Sample data (temporary)

- Add `is_sample boolean not null default false` to `clients`.
- **Load sample data** button: shown on the dashboard when the user has no clients and no projects, and in Settings → Sample data. It creates, using the existing `api.insert` helpers, in this order: sample clients (`is_sample = true`) → projects → milestones, payments and expenses, invoices, renewals, tasks, time entries. Everything except clients hangs off a sample client or sample project, so deleting the sample clients removes it all through the existing cascades.
- Content: 3 clients; 5 projects across all four statuses, one of them in a second currency (the first in the fixed list that differs from the default) so the currency switcher appears; milestones on at least one project; payments and expenses spread over the last 12 months so every chart has shape; one paid invoice and one overdue unpaid invoice; 3 renewals (one due within 30 days, one overdue, one later); some tasks (one overdue) and logged time. Dates are relative to "today" in the user's time zone. Amounts come from a small scale table per currency so they look realistic (INR 1, USD 0.012, EUR 0.011, GBP 0.0095, AUD 0.018, CAD 0.016, SGD 0.016, AED 0.044, NZD 0.02, CHF 0.0105, JPY 1.8, ZAR 0.21 times the rupee amount, rounded to a tidy number).
- **Remove sample data**: confirm first ("This also removes anything you added to the sample clients"), then delete every client with `is_sample = true` (cascades remove the rest).
- Controlled by `LEDGER_CONFIG.sampleData`. The MCP server needs no sample-data code; sample rows are ordinary rows.

### 5.8 Invite-only sign-up

- Table `allowed_emails (email text primary key, note text not null default '', created_at timestamptz not null default now())`. **RLS on, no policies**, so neither visitors nor signed-in users can read or write it; only the owner (SQL editor / Supabase connector) can. (Add a deliberate exception for this one table to the "every table has row-level security and an own-rows policy" consistency test: it must have RLS and **no** policy.)
- A `before insert` trigger on `auth.users` that rejects any sign-up whose email (compared case-insensitively) is not in `allowed_emails`, with the message "This email hasn't been invited yet.":

  ```sql
  create or replace function public.require_invited_email() returns trigger
  language plpgsql security definer set search_path = public as $$
  begin
    if not exists (select 1 from public.allowed_emails where lower(email) = lower(new.email)) then
      raise exception 'This email has not been invited yet.';
    end if;
    return new;
  end $$;
  drop trigger if exists require_invited_email on auth.users;
  create trigger require_invited_email before insert on auth.users
    for each row execute function public.require_invited_email();
  ```

  This also applies to users the owner adds by hand in the Supabase dashboard, so the owner's own email and any new tester must be in the table first. If Supabase refuses a trigger on `auth.users`, use Supabase's "Before User Created" auth hook with the same check instead.
- Website login screen gets a **Create account / Sign in** switch. Sign-up uses `sb.auth.signUp({ email, password })`, then shows "Check your email to confirm your account". An uninvited email shows the friendly message above. Password reset keeps working.
- The OAuth page used to connect Claude (`api/oauth/authorize.js`) needs no sign-up changes: testers create their account on the website first, then connect Claude with the same login.

### 5.9 First-run screen

If a signed-in user has no `settings` row, show (before the dashboard) a short form: business name, default currency, financial-year start month, time zone, locale (pre-filled as in 5.2). Saving inserts the `settings` row, then shows the dashboard with the empty state and the sample-data button.

### 5.10 Safety, privacy and tester experience

- **Cross-user tests** (step 6): extend the tests so that *every* MCP tool, run as the owner against ids and names that belong to `OTHER`, returns nothing or refuses; and a generic test that walks *every table in the schema* so a table added later cannot be forgotten. Do the same for the website's fake client.
- **Service-role key**: the MCP server keeps using it for this round. Moving MCP queries onto the user's own token (so RLS backs them up) is **deferred** and is a prerequisite for any open, uninvited sign-up.
- **Login abuse**: rely on Supabase Auth's built-in rate limits for the website; keep the existing 800 ms delay on the Claude sign-in page. CAPTCHA (Supabase supports Cloudflare Turnstile) is the next step if abuse appears.
- **Delete my account**: a small server function `api/account.js` (POST, user's Supabase access token in `Authorization`, plus their password to confirm). All database/admin calls go inside `api/_lib/supabase.js` (add functions such as `getUser(token)` and `deleteUser(uid)` there; the consistency test only allows that file to talk to Supabase). Deleting the auth user removes every row through `on delete cascade`. Connected Claude apps stop working because the existing account-exists check fails.
- **Download my data**: built in the browser from the user's own rows (`S.raw`) as one JSON file.
- **Privacy page**: a static `privacy.html` in plain English: what is stored (account email, the business data they enter), who can see it (the app owner, who has database access), that this is a test, how to delete it (Settings), and that the owner may delete the whole test and all data on an announced date. Link it from the sign-up screen and Settings.
- **Feedback**: link from Settings and the page footer using `LEDGER_CONFIG.feedbackUrl`.
- **Friendly errors**: a global `window.onerror` / `unhandledrejection` handler that shows a toast ("Something went wrong") with a "Copy details" button so testers can paste what happened.
- **Tester guide**: `docs/TESTERS.md`, one page: what the app is, how to sign up (send your email first), a 10-minute checklist (add a client and project, record a payment, make an invoice, add a renewal, change currency/financial year in Settings, connect Claude and ask three questions), known gaps (no tax, no payment collection, no currency conversion), where to send feedback.

---

## 6. Where hard-coded India assumptions live today

Run this and handle every hit (some are comments or tests; use judgement):

```sh
grep -rnE "₹|rupee|INR|IST|India|en-IN|Asia/Kolkata|fyStart|fyLabel|fyRange|fyOf|financial year|April" index.html api docs README.md CONTRIBUTING.md | grep -v "^tests/"
```

Known places: `rs()`, `fmtDate()`, `fyStart/fyLabel/fyRange/PERIODS`, `upiLink()`, `nextInvoiceNumber()` in `index.html`; `todayIST`, `fyLabel`, `fyRange`, `fyOf`, `periodRange`, `nextInvoiceNumber`, the two `currency: 'INR'` results and the UPI link (`cu: 'INR'`) in `ledger.js`; `₹` in messages and `todayIST()` in `writes.js`; "rupees", "India time" and "Indian financial years" in `tools.js` descriptions and `INSTRUCTIONS`; and wording in `README.md`, `CONTRIBUTING.md`, `docs/mcp.md`.

---

## 7. Testing requirements (what "tested" means here)

Follow `tests/README.md`. In addition:

- **Server**: new tests for per-currency totals (two currencies in one ledger), every currency invariant in section 4, a January financial year, a non-India time zone around midnight (local date ≠ UTC date), invoice numbering across a non-April year boundary, the unchanged owner case (INR, April, India), and the currency lock. Keep `ledger.test.js` and friends passing unmodified for the owner case.
- **Seed**: extend `tests/helpers/seed.js` with a USD project and a second user `OTHER` row for every new table/column; update the header comment's key numbers.
- **Website (e2e)**: extend `open()` to accept time zone, locale, users and an empty ledger. Tests for: the Settings page (every section saves independently, invalid input refused, reachable from every screen, phone width in light and dark mode), the currency picker and lock on the project form, the dashboard currency switcher (only appears with 2+ currencies), formatting in INR/USD/JPY, sign-up and sign-in switch, uninvited-email message, first-run screen, sample data load/remove (default INR and default USD), export, and account deletion.
- **Consistency**: currency list equal in the three places; every table with a `currency` column is handled by the MCP write tools that insert into it; `allowed_emails` exception; `schema.sql` still re-runnable and only adds (the new `create or replace function` / `drop trigger if exists … create trigger` pair is the one deliberate exception to "no drop"; extend that test narrowly to allow it).
- **Sign-up gate**: the fake store cannot run the trigger, so (a) unit-test the website's handling of the "not invited" error with the fake `auth.signUp` returning it, and (b) verify the real trigger on the live project during step 6 (section 10).

---

## 8. Work packages (do them in this order)

Each package ends with: tests added and passing, full suite green, section 0 and the log updated, committed and pushed.

### Step 1 — Database (`supabase/schema.sql`)

Do: add the columns and constraints from sections 4, 5.2 and 5.7 (`projects.currency`, `txns.currency`, `invoices.currency`, `services.currency`, the four `settings` columns, `clients.is_sample`); add `allowed_emails`, the function and the trigger from 5.8. Use `alter table … add column if not exists` and `drop constraint if exists` + `add constraint` for the checks, exactly like the existing status checks.
Tests: update `tests/helpers/seed.js` (new columns, a USD project, `OTHER` rows); update `consistency.test.js` (currency list sync, `allowed_emails` exception, re-runnable-and-only-adds with the trigger exception).
Done when: the schema file runs twice without error on a scratch Postgres or is at least accepted by the repo's schema parser and all consistency tests; the full suite is green.
Gotcha: nothing else in the app should change yet; every existing test must pass unchanged.

### Step 2 — Server: currency, financial year, time zone

Do: in `ledger.js` add `CURRENCIES`, read the new settings (`defaultCurrency`, `fyStartMonth`, `timezone`, `locale`) into `Ledger.settings`, replace `todayIST()` with `todayIn(tz)`, generalise `fyLabel/fyRange/fyOf/periodRange/nextInvoiceNumber`, make `sumOf` and every summary function work per currency (section 4), build the UPI link only for INR. In `writes.js` enforce the currency invariants, take currency from the project, add the optional `currency` inputs, reword `₹` messages using a currency formatter, and use the user's time zone for default dates. In `tools.js` add the optional `currency` input to read tools, reword descriptions, update `INSTRUCTIONS`. Update `docs/mcp.md`.
Tests: section 7 server tests, including `changeAndUndo()` coverage for every new/changed write path (undo must restore `currency` too).
Done when: owner-case tests pass unmodified; new tests cover each invariant; no `todayIST`, hard-coded `INR`/`₹` or "Indian financial year" remains in `api/` except in tests and the INR-only UPI code.

### Step 3 — Website: currency, financial year, time zone, Settings page

Do: add the `currency` field to `map` for the four tables and the new `settings` fields; add the formatter and time-zone-aware `today()`; make `PERIODS`/`periodBuckets`/`inPeriod`/invoice numbering use the start month; add the currency picker to the project, payment/expense, invoice and renewal forms with the lock and auto-fill rules; compute every total per currency and add the dashboard switcher; build the Settings page (5.5) and remove `openSettingsSheet`; point the Invoices page links and notice at it; show the UPI QR only for INR invoices.
Tests: section 7 website tests; update the existing settings/invoice e2e tests to use the page.
Done when: with default settings the site looks and behaves as before; a USD / January-start / New York user sees correct periods, formatting and invoice numbers; phone width and dark mode checked.

### Step 4 — Invite-only sign-up and first-run

Do: login screen sign-up switch (5.8), "check your email" and "not invited" messages, first-run screen (5.9), extend the fake `auth` in `tests/e2e/fake-supabase-js.js` with `signUp` (and an allow-list option in the test init so tests can simulate refusal).
Tests: sign up success path, uninvited refusal message, first-run saves `settings`, a user with an existing `settings` row skips first-run.
Done when: all of the above pass; the real trigger is verified later in step 6.

### Step 5 — Sample data

Do: section 5.7, behind `LEDGER_CONFIG.sampleData`.
Tests: load for default INR and default USD, switcher appears, dashboard numbers non-zero, remove deletes only sample rows and leaves a real client, project and payment untouched, button hidden when the flag is off or the ledger is not empty.
Done when: the above pass and the dashboard looks sensible at phone width.

### Step 6 — Cross-user safety and live database checks

Do: the cross-user tests (5.10): all MCP tools against `OTHER`'s ids and names, a loop over every schema table, the same for the website fake client. Then (live, see section 10): apply the schema, run Supabase's security advisors, verify the trigger with a real sign-up of an uninvited email (must fail) and an invited second email (must succeed), and delete that test account afterwards.
Done when: tests green; advisors show no new warnings on the new tables; the trigger behaves as specified on the live project.

### Step 7 — Account deletion, export, privacy, feedback, errors

Do: 5.10. `api/account.js` and the helper functions in `api/_lib/supabase.js`; export; `privacy.html`; feedback link; global error handler.
Tests: server test that deleting removes the user's rows and leaves `OTHER`'s intact and refuses a wrong password or missing token; e2e test for export content and the delete flow; consistency test still passing (only `supabase.js` touches the database).
Done when: the above pass.

### Step 8 — Documentation

Do: update `README.md` (no longer "single owner, sign-ups turned off"; currency/FY/time-zone settings; the sign-up and allow-list owner steps; Setup section), `CONTRIBUTING.md` (the line "Money is in rupees, dates are … India time, and the owner is the only user" and the design decisions that mention April), `docs/mcp.md`, `tests/README.md` (new coverage), add `docs/TESTERS.md`. Tick the status table in `CONTRIBUTING.md` if it has one for this work.

### Step 9 — Dry run

Do: the owner (or you, with the owner's second email on the allow-list) signs up on the live site, goes through the first-run screen and the tester checklist in `docs/TESTERS.md`, connects Claude, loads and removes sample data, changes currency/FY/time zone, exports and deletes the account. Fix what breaks. Only then does the owner post to Reddit.

---

## 9. Done when (the whole round)

- A new invited person can sign up, confirm their email, finish first-run, load sample data and see a populated dashboard in their own currency and financial year.
- They can create projects in different currencies and see correct per-currency totals; a January financial year and a non-India time zone give correct periods, invoice numbers and overdue dates.
- An uninvited email cannot create an account.
- No user can see or change another user's data through the website or any Claude tool; tests prove it for every tool and every table.
- Settings is a full page reachable from every screen and no settings pop-up remains.
- Sample data can be removed without touching real data, and the feature can be switched off by one config flag.
- The owner's existing data and behaviour are unchanged.
- The full suite is green in CI.

## 10. Releasing and touching the live system

`CONTRIBUTING.md` "Releasing a change" is the authority; in short:

1. The step's code and tests are done and the full suite is green.
2. **Run `supabase/schema.sql` on the live database before merging**, twice (the second run must succeed too). The owner wants this done through the Supabase connector (`execute_sql` on the `client-ledger` project) rather than asked of them. The connector times out on long runs and on `drop policy`, and each timed-out call rolls back: run the file in parts, and for a new table's policy just `create policy` once. Verify afterwards with queries on `pg_policies`, `pg_constraint`, `pg_indexes` and `information_schema.columns`. If you have no Supabase connector in your session, give the owner the exact SQL and wait. Schema changes only add things, so the already-deployed code keeps working.
3. Merge only when the owner asks (this branch's instructions: no pull request unless asked). CONTRIBUTING says merging is automatic once the check is green; the owner's explicit request to merge still comes first.
4. After deploying, check the live site briefly (sign in/out, dashboard for every period, add/edit/delete a payment, project and client pages, phone width) and in Claude (`get_summary`, one write and its undo, a delete without `confirm` changes nothing).
5. If something breaks: Vercel → Deployments → Instant Rollback, then fix on a new branch.

## 11. Owner-only steps (not code; a developer cannot do these)

- Create an SMTP account (for example Resend's free tier) and enter it in Supabase → Authentication → SMTP. Supabase's built-in email sender has a very low hourly limit and testers may never receive their confirmation email without this.
- Supabase → Authentication: turn **on** "Allow new users to sign up" and email confirmation; set the Site URL and redirect URLs to the live site.
- Add the owner's own email and a second test email to `allowed_emails`, and each tester's email before they sign up.
- Choose the feedback address for `config.js`.
- Decide the date the test ends and what happens to testers' data then (state it on the privacy page).

**Out of scope for this round:** billing and plans; teams or agency seats; GST/TDS/VAT or any tax; currency conversion; languages other than English; moving MCP queries onto row-level security (required before any open sign-up); CAPTCHA; a landing page; a frontend rewrite; anything for marketing-style agencies.

**Risks to watch:**

- Mixed currencies are the biggest change. Every total and every tool result must be grouped by currency; this is where wrong numbers could slip in.
- Existing rows must default to INR or the owner's ledger changes meaning.
- Email deliverability: if confirmation emails do not arrive, testers cannot get in. Test with a real second address in step 9.
- Same database as the owner's: a bad migration affects the owner's data. Keep to "only add".
- The sign-up trigger sits on `auth.users`. It runs on insert only, so existing users and password resets are unaffected, but a mistake in it could block every new sign-up. Test it on the live project in step 6 before announcing anything.

## 12. Log (add a line per finished step: date, step, what changed, anything the next person must know)

| Date | Step | Notes |
|---|---|---|
| | | |
