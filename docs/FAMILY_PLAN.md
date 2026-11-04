# Plan: Client Ledger for the family

This document is written so that a developer, or a Claude instance, who has never seen this project can do the work from it. Read sections 1 to 4 before touching any code. Section 5 says what to build, section 6 is the step-by-step work, section 7 covers releasing, and section 8 is what the owner does by hand.

It replaces the earlier plan to open the app to five outside testers. That plan's steps 1 to 3 (currency, financial year and time zone per user, and the Settings page) were built and are live; the rest (self sign-up, sample data, privacy page, tester guide, feedback link) is dropped.

## 0. Progress (update this as you go)

Tick a step only when its "Done when" list is true, its tests pass and the full suite is green. Add one line to the log at the bottom.

| Step | What | Status |
|---|---|---|
| 1 | Database: currency, regional settings, invite list and sign-up gate | done, **live** (checked 2026-11-04: all columns, `allowed_emails` and the `require_invited_email` trigger exist on the live database) |
| 2 | Server (MCP): currency, financial year, time zone | done, on `main` |
| 3 | Website: currency, financial year, time zone, Settings page | done, on `main` |
| 4 | Kind of business (web development, products, general) | not started |
| 5 | Cross-user safety tests and live checks | not started |
| 6 | Small extras: friendly errors, Download my data | not started |
| 7 | Documentation, including "Adding a family member" | not started |
| 8 | Add the first family member and check everything with them | not started |

---

## 1. The goal, in plain words

Client Ledger is a personal app the owner built to run their freelance web-development business: clients, projects, payments, expenses, invoices, renewals, tasks and time. The owner now wants **a few members of their own family** to use it too.

- **Every person has their own, separate ledger.** Nobody shares data and nobody can see anyone else's. The database already works this way (every row has a `user_id` and row-level security).
- **The owner creates every account by hand** in the Supabase dashboard. There is no sign-up screen, no billing, no marketing, no public launch.
- **Family members run different kinds of business.** One does freelance web development (like the owner); another makes and sells **custom gift boxes**; others may do something else. Today the app speaks only web development: projects have Preview / Live site / GitHub links, expense categories are Domain, Hosting, Software & plugins and so on, the Renewals page is about domains and hosting, and Claude is told it is looking at "a freelance web developer's" ledger. Step 4 fixes this with a per-person **kind of business** setting.

**The owner's own account must behave exactly as it does today after every step.** The existing tests protect this; do not weaken or delete them to make a change pass.

## 2. How the project works (read this before coding)

### 2.1 Architecture

```
Browser: index.html + config.js ──supabase-js (anon key)──▶ Supabase (Postgres + Auth, row-level security)
Claude / MCP client ──OAuth──▶ api/mcp.js (Vercel function) ──service key, every query filtered by user_id──▶ Supabase
```

- **The website** is one file, `index.html` (HTML, CSS and plain JavaScript) plus `config.js`. There is **no build step, no framework and no npm packages for the site**; do not add any. It talks to Supabase directly from the browser; row-level security (RLS) keeps each signed-in user to their own rows.
- **The database** is Supabase Postgres. `supabase/schema.sql` is the entire schema and is safe to run again and again.
- **The MCP server** (so Claude can read and change a ledger) lives in `api/` as Vercel serverless functions. It uses Supabase's **service key**, which **bypasses RLS**, so every query is filtered by `user_id` by hand, in exactly one place: `forUser(uid)` in `api/_lib/supabase.js`. A test fails if any other file talks to the database or a request lacks a `user_id` filter. This is why step 5 matters: with family finances on one database, this filter is the only thing between one person's Claude and another person's money.
- **Hosting** is Vercel. Environment variables: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OAUTH_SECRET`. Never print them, never put the service key anywhere else, never change `OAUTH_SECRET` (it signs every connected Claude app out, for every family member).
- The live Supabase project is `client-ledger` (URL in `config.js`; the anon key there is public by design).

### 2.2 File map

| File | What it is |
|---|---|
| `index.html` | The whole website. Helpers: `h()` builds elements, `sheet()` opens a pop-up form, `confirmSheet()`, `toast()`. `S` is the global state (`S.clients`, `S.projects`, `S.txns`, `S.settings`, …). `api.insert/update/del` change the screen immediately and save in the background. `parseHash()` / `go()` route on the URL hash; `render()` maps view names to `render…` functions. `map` converts database rows to objects. `STATUSES`, `CATEGORIES`, `LINKS` (project links) and `KINDS` (renewal kinds) are the web-development-specific lists step 4 touches. Money formatting is `rs()` / `ex()`; dates `today()` / `fmtDate()`; the Settings page is `renderSettings()` built from `settingsCard()` sections. |
| `config.js` | Supabase URL and anon key. |
| `supabase/schema.sql` | All tables, columns, constraints, indexes, RLS policies and the sign-up gate. |
| `api/mcp.js` | The MCP endpoint (JSON-RPC over HTTP). Sends `INSTRUCTIONS` on `initialize`. |
| `api/oauth/*.js`, `api/_lib/oauth.js` | OAuth 2.1 so Claude can connect. Each family member connects with their own email and password. |
| `api/_lib/supabase.js` | The only code that talks to the database: `forUser(uid)`, `signIn()`, `userStillActive()`. |
| `api/_lib/ledger.js` | Read side: `load(db)`, the `Ledger` class, `CATEGORIES`, `STATUS_LABELS`, `KIND_CATEGORY`, date and money helpers, every read calculation. |
| `api/_lib/writes.js` | Write side: input checks (`fail()`), the `Change` class (undo log), one function per write tool. |
| `api/_lib/tools.js` | The MCP tool list Claude sees, plus `INSTRUCTIONS` and `PROMPTS`. |
| `docs/mcp.md` | Human documentation of the MCP server. |
| `tests/` | Offline tests; see 2.4. |
| `README.md`, `CONTRIBUTING.md` | Product description and the rules for changing the code. **Read `CONTRIBUTING.md` fully; its rules apply to every step.** |

### 2.3 Rules that apply to every step (from `CONTRIBUTING.md`; read the original too)

- **Database changes only add.** Never drop or rename columns or tables. New columns need a default or must be nullable. Keep the file re-runnable (`if not exists`, `drop … if exists` + `add`).
- Lists repeated in several files (statuses, expense categories, periods, currencies, tables) are kept in sync by `tests/consistency.test.js`. New lists from step 4 get the same treatment.
- Website: match the existing style (`h()`, `sheet()`, `api.*`), short comments, plain-words labels; check new screens at phone width in light and dark mode.
- MCP: all database access through `forUser()`; write tools follow the existing `load → fail() → new Change → ch.ready() → ch.insert/update/remove → done()` pattern; deletes are two-step. Update `INSTRUCTIONS` and `docs/mcp.md` when behaviour changes.
- **Every feature ships with its tests** (`tests/README.md`, "When you add a feature").

### 2.4 Running the tests (Node 22)

```sh
node --test tests/*.test.js        # server, database and consistency tests
node --test tests/e2e/*.test.js    # the website in a real browser (Chromium via Playwright)
```

First time only for the website tests: `npm ci --prefix tests/e2e` (Claude Code cloud sessions already have Chromium; do not run `playwright install` there).

- Everything runs offline against a **fake Supabase** built from `supabase/schema.sql` (`tests/helpers/schema.js`, `store.js`). Writing a column that is not in the schema fails; any server request without a `user_id` filter fails.
- `tests/helpers/seed.js` is the test ledger ("today" is fixed at 2026-10-23, India time). It has a **second user, `OTHER`** (USD, January financial year, New York), whose data must never appear or change. `seedUsd(store)` adds a USD project for the owner.
- `tests/e2e/website.test.js` has an `open()` helper that takes `timezone`, `locale`, `settings`, `usd`, `empty` and `prepare`.
- GitHub Actions runs both commands on every pull request and push to `main`.

### 2.5 Working agreement

- Develop on the branch you were given (currently `claude/session-1otory`). Commit in small steps with clear messages and push. **Do not open a pull request or merge unless the owner asks.**
- Keep the whole suite green after every step. Never skip, delete or loosen a test to get green; if an old test must change because behaviour intentionally changed, change it narrowly and say why in the commit message.
- When you finish a step, tick it in section 0 and add a line to the log (section 9).

---

## 3. Decisions (made by the owner; do not re-open them)

| Question | Decision |
|---|---|
| Who uses it? | The owner and a few family members. Nobody else. |
| Separate or shared data? | **Separate.** Each person has their own ledger; no household or team model. |
| How do people get an account? | The owner creates it in the Supabase dashboard (section 8). Public sign-up stays **off**. No sign-up screen is built. |
| Different kinds of work | Yes: web development, custom gift boxes, possibly others. Handled by a per-person "kind of business" setting (step 4), not by separate apps. |
| Sample data, privacy page, tester guide, feedback link, CAPTCHA, billing | Not needed. Dropped. |
| Delete an account | The owner does it in the Supabase dashboard (Authentication → Users → Delete). Every row goes with it through `on delete cascade`. No in-app button. |
| Currency, financial year, time zone | Kept as built in steps 1–3 (each person can pick their own). |

## 4. What already exists and stays

- **Per-person settings** (`settings` row, one per user): business details, invoice prefix and terms, `default_currency`, `fy_start_month`, `timezone`, `locale`. A new person with no `settings` row gets the defaults (INR, April, India time, `en-IN`), which suits an Indian family member; they can change them on the Settings page.
- **The sign-up gate** (`allowed_emails` table + `require_invited_email` trigger on `auth.users`). Keep it as a second lock behind "sign-ups off": even if sign-ups were switched on by mistake, only listed emails can get an account. It also applies to accounts the owner adds in the dashboard, so **an email must be in `allowed_emails` before the account is created** (section 8). The list is empty today; the owner's own account already exists and is not affected.
- **`clients.is_sample`** (added for the dropped sample-data feature). Unused. Leave it: the database rules say only add, and it does no harm.

---

## 5. What to build: kind of business (step 4)

### 5.1 The idea

A new per-person setting, `settings.business_type`, picks a **preset** that changes words, lists and which web-only parts are shown. The data model does not change: an order for a gift box is stored as a project, its customer as a client, its advance and balance as milestones, its packaging costs as expenses, and so on. Everything that works today (dashboard, invoices, milestones, chasing payments, tasks and time) works for every kind of business.

| `business_type` | For | Default for |
|---|---|---|
| `web_dev` | Freelance web development (today's app, unchanged) | the owner and every existing row (column default) |
| `products` | Making and selling things to order: custom gift boxes, cakes, crafts, printing | |
| `general` | Any other service: design, photography, tuition, consulting | |

### 5.2 What each preset changes

| | `web_dev` | `products` | `general` |
|---|---|---|---|
| A project is called | Project | Order | Job |
| A client is called | Client | Customer | Client |
| Status labels (stored values stay `lead/active/paused/done`) | Lead, In progress, On hold, Done | Enquiry, Making, On hold, Delivered | Enquiry, In progress, On hold, Done |
| Date and price labels (stored in `start_date`, `due_date`, `quoted`) | Start date, Due date, Quoted (unchanged) | Order date, Delivery date, Price | Start date, Due date, Quoted |
| Project links (Preview, Live site, GitHub) | shown | hidden | hidden |
| Renewals tab and dashboard card | shown | hidden unless the person already has a service | hidden unless the person already has a service |
| Expense categories | Domain, Hosting, Software & plugins, Design assets, Contractor, Ads & marketing, Travel, Other (unchanged) | Materials & packaging, Products & stock, Printing & labels, Shipping & delivery, Platform & payment fees, Ads & marketing, Travel, Other | Equipment, Software & subscriptions, Materials, Contractor, Ads & marketing, Travel, Other |
| Placeholder examples in forms | today's | "e.g. Diwali hamper for Sharma family", "e.g. Ribbons and boxes" | neutral |

Notes:

- The date and price labels apply everywhere those fields appear: the order form, the order page and cards, the dashboard's "due soon" list, and the wording Claude is given ("delivery date" for `products`). Tool input names (`start_date`, `due_date`, `quoted`) stay the same.
- Only **labels** change for statuses, so the five status lists and the `projects_status_check` constraint stay as they are.
- Expense categories are free text in the database (`txns.category text not null default ''`), so **no schema change** is needed for them. Old entries keep their category even if it is not in the person's current list; forms and filters must still show it (add it to the dropdown when editing such an entry).
- Hiding something never deletes data. If a `products` person switches to `web_dev`, their data is all still there.
- Adding another kind of business later means adding one preset entry in each of the two places in 5.3 and running the consistency test.

### 5.3 Where it lives

- **Schema:** `alter table public.settings add column if not exists business_type text not null default 'web_dev';` plus a `settings_business_type_check` (drop if exists + add) for the three values.
- **One preset table, written twice and kept identical by a consistency test:** `BUSINESS_TYPES` in `index.html` and in `api/_lib/ledger.js` (keys, words, status labels, categories, `links: true/false`, `renewals: true/false`). `CATEGORIES` stays as the `web_dev` list so existing tests and code keep working; add a helper `categoriesFor(type)`.
- **Website:**
  - Settings page → **Business** section gets a "Kind of business" picker with one line of help per option. Saving redraws the app with the new words.
  - Replace the hard-coded words "Project(s)", "Client(s)" in tab names, headings, buttons and empty states with the preset's words (keep URLs like `#/projects` as they are).
  - Project form: hide the three link fields when `links` is false (keep any stored values; show them read-only on the project page only if they are not empty).
  - Hide the Renewals tab and dashboard card when `renewals` is false and the person has no services.
  - Expense form and Money filter use `categoriesFor(type)` plus any category already used on that entry.
- **Server (MCP):**
  - `Ledger.settings.businessType`; `get_settings` and `update_settings` read and write `business_type`.
  - Expense categories are checked against `categoriesFor(type)` (plus "keep the entry's existing category" on update). The tool schemas' `category` enum becomes the union of all presets' lists, with the description saying which apply to which kind of business.
  - `INSTRUCTIONS` is built per person: `mcp.js` already knows the user on `initialize`, so load their `settings` and send the instructions for their kind of business ("a custom gift-box business's customers, orders, payments and expenses …"). The web wording stays exactly as today for `web_dev`.
  - Tool names stay the same for everyone (`create_project`, `list_clients`, …); descriptions say "project (order or job)" so Claude understands either word. The link inputs stay but are described as web-development only.

### 5.4 Out of scope for step 4 (ask the owner first)

**Decided against (2026-11-04): a one-step "Record a sale" form.** A sale is recorded by creating the order (a new customer can be added in the same form) and then recording its payment. Do not build a shortcut unless the owner asks.

A gift-box business may later want **a product catalogue** (named boxes with a standard price), **stock of materials** (how many boxes and ribbons are left), **delivery addresses and dates**, or **GST on invoices**. None of these exist today and none are part of this plan. If the gift-box family member asks for one, add it as its own step with its own tests.

---

## 6. Work packages (do them in this order)

Each package ends with: tests added and passing, full suite green, section 0 and the log updated, committed and pushed.

### Step 4 — Kind of business

Do: section 5.
Tests:
- Consistency: `BUSINESS_TYPES` identical in `index.html` and `ledger.js`; the schema check lists the same keys.
- Server: `products` user's expense with "Materials & packaging" accepted, "Hosting" refused with a message listing the right categories; updating an old entry that keeps a category outside the list is accepted; `get_settings` / `update_settings` round-trip `business_type` with undo; `initialize` sends gift-box instructions for a `products` user and today's exact text for the owner.
- Website: a `products` user sees "Orders" and "Customers", Enquiry/Making/Delivered, "Order date", "Delivery date" and "Price" on the order form and page, no link fields and no Renewals tab; a `products` user who has a service still sees Renewals; switching the setting changes the words without losing data; the owner (`web_dev`) sees no change (existing tests pass unmodified); phone width, light and dark.
Done when: all of the above pass.

### Step 5 — Cross-user safety and live checks

Do:
- A test that runs **every MCP tool** as the owner against ids and names that belong to `OTHER` and checks each one returns nothing or refuses, and that `OTHER`'s rows are unchanged afterwards. Build the tool list from `TOOLS` so a tool added later is covered automatically.
- A test that walks **every table in the schema** (from `tests/helpers/schema.js`) and checks the owner can neither read nor change `OTHER`'s rows through the website's fake client. Skip `allowed_emails` (it has no `id` and no policies by design) and assert that it has RLS on and no policies.
- **Links across ledgers.** RLS checks a row's own `user_id`, but not the ids it points at (`client_id`, `project_id`, `invoice_id`, `milestone_id`). Today someone who knew another person's client id could attach a payment to it through the browser. Within a family this is a low risk, but close it: add a check that the parent row has the same `user_id`. Preferred, because it only adds: a `before insert or update` trigger per child table that raises an error when the referenced row's `user_id` differs. Add server and fake-store tests for it.
- Live (section 7): run Supabase's security advisors and check for no new warnings; with a throwaway email in `allowed_emails`, create a test account in the dashboard, sign in on the website and through Claude, confirm it sees an empty ledger and none of the owner's data, then delete the account and remove the email.
Done when: tests green, advisors clean, the live check passes.

### Step 6 — Small extras

Do:
- **Friendly errors:** a global `window.onerror` / `unhandledrejection` handler that shows a toast ("Something went wrong") with a "Copy details" button, so a family member can send the owner what happened.
- **Download my data:** a button in Settings → a new "Your data" section that saves the person's own rows (`S.raw`) as one JSON file.
Tests: e2e for both (the toast appears on a thrown error; the export contains the user's rows and none of `OTHER`'s).

### Step 7 — Documentation

Do:
- `README.md`: from "built for a single owner (sign-ups are turned off)" to "the owner and a few family members, each with a separate ledger; accounts are created by the owner"; mention the kind-of-business setting and the currency / financial year / time zone settings.
- `CONTRIBUTING.md`: replace "Money is in rupees, dates are in India time, and the owner is the only user" with the per-person settings; add `BUSINESS_TYPES` to the list of lists kept in sync.
- `docs/mcp.md`: per-person instructions and categories.
- New `docs/FAMILY.md`: a one-page guide for family members (sign in, change your password, Settings, add a customer and an order, record a payment, make an invoice, connect Claude) and the owner's **"Adding a family member"** steps from section 8.

### Step 8 — First family member

Do: the owner adds one family member (section 8). Sit with them: they sign in, pick their kind of business and currency, enter one real customer, order and payment, make an invoice, and connect Claude. Fix what breaks, then add the others.

---

## 7. Releasing and touching the live system

`CONTRIBUTING.md` "Releasing a change" is the authority; in short:

1. The step's code and tests are done and the full suite is green.
2. Run `supabase/schema.sql` on the live database **before** merging, twice (the second run must succeed). Do it through the Supabase connector (`execute_sql` on the `client-ledger` project); it times out on long runs and on `drop policy`, and a timed-out call rolls back, so run the file in parts. Verify with queries on `information_schema.columns`, `pg_constraint`, `pg_policies` and `pg_trigger`. Without a connector, give the owner the exact SQL and wait.
3. Merge only when the owner asks.
4. After deploying, check the live site (sign in/out, dashboard, add/edit/delete a payment, project and client pages, phone width) and in Claude (`get_summary`, one write and its undo, a delete without `confirm` changes nothing).
5. If something breaks: Vercel → Deployments → Instant Rollback, then fix on a new branch.

Every family member uses the same live site, so a bad release affects everyone. Keep to "only add" in the database.

## 8. Owner-only steps

**Adding a family member** (each time):

1. Supabase → Authentication → Sign In / Providers: check **"Allow new users to sign up" is off**.
2. Add their email to the invite list (Claude can do this through the Supabase connector):
   `insert into public.allowed_emails (email, note) values ('name@example.com', 'Priya – gift boxes');`
3. Supabase → Authentication → Users → **Add user** → **Create new user**: their email, a starting password, tick **Auto Confirm User**.
4. Send them the site address and the starting password; they change it with "Forgot password" or you change it for them in the dashboard.
5. They open **Settings**, choose their kind of business, currency, financial year and time zone, and fill in their business details for invoices.
6. To use Claude, they add the connector with the site's `/api/mcp` address and sign in with the same email and password.

**Removing a family member:** Supabase → Authentication → Users → Delete user. This deletes all their data and disconnects their Claude. Also delete their `allowed_emails` row.

**Password resets:** the website's "Forgot password" uses Supabase's built-in email sender, which is enough for a family. Check the Site URL and redirect URLs in Supabase → Authentication → URL Configuration point at the live site.

## 9. Log (add a line per finished step: date, step, what changed, anything the next person must know)

| Date | Step | Notes |
|---|---|---|
| 2026-10-23 | 1 | (Old plan, step 1.) Added `currency` on `projects`, `txns`, `invoices`, `services`; `default_currency`, `fy_start_month`, `timezone`, `locale` on `settings`; `clients.is_sample`; `allowed_emails` (RLS on, no policies) and the `require_invited_email` trigger, with `revoke execute` on the gate function. `seed.js` has `seedUsd(store)`; `OTHER` is USD / January / New York. `store.js` assumes every table has an `id`, but `allowed_emails` has none. |
| 2026-10-23 | 2 | (Old plan, step 2.) `ledger.js`: `CURRENCIES`, `todayIn(tz)`, `formatMoney`, financial-year helpers take the start month; money tools run per currency and add `otherCurrencies`. `writes.js` enforces the currency rules and uses the user's time zone. New `tests/currency.test.js`. `whatsappNumber()` still treats a 10-digit number as Indian (+91). |
| 2026-10-23 | 3 | (Old plan, step 3.) `index.html`: amounts in their own currency and the user's locale; `today()` from the settings time zone; financial year from `fy_start_month`; per-currency totals and a currency switcher; currency pickers with locks; UPI only for INR; `#/settings` page (Business, Invoices, Region) replaces the settings pop-up. Saving one Settings section redraws the page, so unsaved text in other sections is reset. |
| 2026-11-04 | — | Plan rewritten for family use (separate ledgers, accounts created by the owner, a kind-of-business setting). Checked the live database: step 1 is applied; `allowed_emails` is empty and there is one user (the owner). Dropped: sign-up screen, first-run screen, sample data, account deletion button, privacy page, feedback link, tester guide. |
