# Plan: open Client Ledger to 5 outside testers

Goal: five freelance web developers (India and elsewhere), recruited on Reddit, can sign up themselves, use the app with their own data, never see anyone else's, and tell us what's wrong.

This plan is for the **test round only**. It is not the full SaaS conversion (billing, teams, tax, marketing site, frontend rewrite are out of scope; see the end).

## Decisions

| Question | Decision |
|---|---|
| How do testers get in? | They send the owner their email; the owner adds it to an allow-list; they then **sign up on their own** with that email. Anyone not on the list is refused. |
| Where does it run? | The **same** Supabase and Vercel project as the owner's data. No staging copy. The owner accepts the risk to their own data. |
| Language and tax | English only. No GST, TDS or other tax features. |
| Currency | A **fixed list** of currencies. **Each project has exactly one currency**; different projects can use different ones. No conversion. |
| Financial year | A per-user setting (start month), changeable on the Settings page. |
| Time zone | A per-user setting, chosen at first sign-in. |
| Settings | One **full Settings page per user** (`#/settings`), replacing today's "Your business details" pop-up. Projects get no settings page; a project's only own setting is its currency, in the Edit project form. |
| Sample data | A temporary button that fills an empty dashboard with dummy data, and another that removes it again. |

The owner's own account must behave exactly as it does today (INR, April start, India time) after every step. Existing tests are the guard for that.

## What changes, by area

### 0. Settings becomes a full page

Today settings is a pop-up (`openSettingsSheet`) that is only reachable from the Invoices page ("Your details" button and the setup notice). With currency, financial year, time zone, sample data, export and delete added, it needs its own page.

- New route `#/settings` (add to `parseHash`/`hrefOf`), reached from a **Settings** link in the top bar next to Sign out, so it is visible from every screen. It is not a tab in the main section bar.
- Sections, each saved on its own so a mistake in one doesn't block the others:
  - **Business**: name, address, phone, email (what's printed on invoices today).
  - **Invoices**: prefix, payment terms, notes on every new invoice, UPI ID (shown only when the default currency is INR) and payment/bank details.
  - **Regional**: default currency, financial year start month, time zone, date format. Shows what will change (for example "Your financial year runs 1 January to 31 December").
  - **Sample data**: Load / Remove (while `config.js` `sampleData` is on).
  - **Your data and account**: Download my data, Delete my account, link to the privacy page, feedback link.
- The Invoices page keeps a small "Your details" link and the setup notice, but both now go to `#/settings` instead of opening a pop-up.
- The same validations as today (UPI format, prefix, payment terms) carry over unchanged.
- Existing `settings` rows keep working: new columns have defaults. A user with no `settings` row is taken to this page's first-run version (section 3).
- Tests: the existing settings and invoice-setup end-to-end tests are updated to use the page; add tests that every section saves independently, that invalid input is refused, that the page is reachable from every screen, and that it works at phone width in light and dark mode.

### 1. Currency, financial year, time zone, locale

Today these are hard-coded: `rs()` and `en-IN` in `index.html`, `todayIST()` and the April–March logic in `api/_lib/ledger.js` and `index.html`, `currency: 'INR'` in `ledger.js`, and `cu: 'INR'` in the UPI link.

**Currency per project (the main design point)**

- `projects.currency` (text, default `'INR'` so every existing project stays rupees, checked against the fixed list).
- Money rows do not get their own currency column. They take it from their project: payments and expenses (`txns.project_id`), invoices (`invoices.project_id`), services (`services.project_id`), milestones (via the project).
- Money with **no project** (a general expense, an invoice with no project, a service with no project) uses the user's **default currency** from settings.
- A project's currency is **locked once it has any money, invoice, milestone or service**, so totals can never silently change meaning. To change it the user must remove those first. (Simplest rule that avoids mixed currencies inside one project.)
- New projects start with the user's default currency; the Edit project form (the only project-level setting) lets them pick another from the list.
- Invoices, reminders and the UPI/payment text show the project's currency. The UPI QR only appears for INR; other currencies show the "payment details" text.

**Dashboard, reports and Claude tools with more than one currency**

- No conversion and no summing across currencies. Every total (revenue, spending, profit, still to collect, charts, category breakdown, most profitable projects) is calculated **per currency**.
- The dashboard shows the default currency's numbers first, with a small currency switcher that appears only when the user has money in more than one currency. Users with one currency see no change.
- MCP read tools (`get_summary`, `compare_periods`, `list_overdue`, `get_attention_items` and the rest) return figures grouped by currency and say which currency each number is in. Money amounts in tool results always carry a `currency` field.

**New per-user settings** (new columns on `settings`, all with defaults that reproduce today's behaviour):

- `default_currency` (default `INR`)
- `fy_start_month` (1–12, default `4`)
- `timezone` (IANA name, default `Asia/Kolkata`)
- `date_locale` is derived from the currency/time zone choice where sensible and otherwise a small fixed list (`en-IN`, `en-US`, `en-GB`); number grouping follows it.

**Fixed currency list** (one shared constant, used by the website, the server, the schema check and the tests): `INR, USD, EUR, GBP, AUD, CAD, SGD, AED, NZD, CHF, JPY, ZAR`. Adding one later means editing that one list and the schema check. A consistency test keeps the copies in sync.

**Financial year**

- `fy_start_month = 1` means a calendar year and is labelled `2026`; any other start gives `2026-27` style labels (April start keeps today's labels exactly).
- Invoice numbers keep the form `PREFIX/<label>/001` and restart each financial year. Existing invoice numbers are never changed.
- Month granularity is deliberate. Tax years that start mid-month (for example 6 April in the UK) are approximated by their start month and the settings page says so.

**Time zone**

- "Today" for due dates, overdue checks, renewals and invoice dates comes from the user's time zone, in both the website and the server. `todayIST()` becomes `today(tz)`.
- Defaults to the browser's time zone at first sign-in, which the user can change in Settings.

**Code touch-points**: `index.html` (formatters, period logic, FY logic, project/invoice/service forms, settings page), `api/_lib/ledger.js` (periods, totals, attention items, invoice numbers, UPI), `api/_lib/writes.js` (invoice numbering, project create/update, currency lock), `api/_lib/tools.js` (tool descriptions that say "rupees"/"India time"), `supabase/schema.sql`, `docs/mcp.md`, `README.md`.

### 2. Sign-up gated by an email allow-list

- New table `allowed_emails (email text primary key, note text, created_at)`. Row-level security on with **no** policies, so no signed-in user or visitor can read it. Only the owner (through the Supabase connector or SQL editor) and the database itself touch it.
- A `before insert` trigger on `auth.users` rejects any sign-up whose lower-cased email is not in `allowed_emails`, with a plain message ("This email hasn't been invited yet").
- In the Supabase dashboard (owner steps, documented in the README): turn on email sign-ups, require email confirmation, set the site URL and redirect URLs, and set up **custom SMTP** (for example Resend's free tier). Supabase's built-in email sender has a very low hourly limit and can silently stop confirmation emails reaching testers.
- Website: a **Create account** / **Sign in** switch on the login screen, sign-up with email + password, a "check your email" screen, and a clear message when the email is not invited. The existing password-reset flow stays.
- The OAuth sign-in page used when connecting Claude (`api/oauth/authorize.js`) needs no change for sign-up: testers create their account on the website first, then connect Claude with the same login.
- Owner workflow for each tester: add their email to `allowed_emails`, tell them to sign up. Adding the helper to do that from the Supabase connector is a one-line insert and is documented, not built into the app.

### 3. First-run flow

When a new user has no `settings` row, show one short first-run version of the Settings page's Business and Regional sections before the dashboard: business name, default currency, financial year start, time zone (pre-filled from the browser). It saves the `settings` row, then shows the dashboard with the empty state and the sample-data button.

### 4. Sample data (temporary)

- A **Load sample data** button on the empty dashboard (and in the Settings page's Sample data section), and a **Remove sample data** button.
- It creates, in the user's default currency with amounts that look realistic for it: 3 clients, 5 projects across the statuses (one in a second currency to show the switcher), milestones, payments and expenses spread over the last 12 months so every chart has shape, an overdue invoice and a paid one, 3 renewals (one due soon, one overdue), tasks and logged time. Dates are relative to today so the dashboard always looks alive.
- One new column, `clients.is_sample boolean not null default false`. Every other sample row hangs off a sample client and is removed by the existing cascades, so **Remove sample data** is a single delete of the sample clients. Anything the tester adds to a sample client is removed with it; the button says so.
- The button is controlled by a flag in `config.js` (`sampleData: true`) so it can be switched off or deleted before any public launch without hunting through the code.
- The MCP server needs no changes for this beyond the currency work, since sample rows are ordinary rows.

### 5. Keeping testers' data separate and safe

- **Cross-tenant tests**: the seed already contains a second user whose data must never appear. Extend it so *every* MCP tool (read and write, including `undo_change`, the two-step deletes and `search`) is run as user A against ids and names belonging to user B and must return nothing or refuse; and run the same check over every table in the schema so a new table cannot be forgotten. Add the same check for the website's fake Supabase client.
- **Allow-list tests**: sign-up for an invited email works, for an uninvited one it is refused, case differences don't matter, and a signed-in user cannot read `allowed_emails`.
- **Database advisors**: after the schema is applied to the live project, run the Supabase security advisors and fix anything flagged on the new tables.
- **Service-role key**: the MCP server keeps using it for now (it scopes every query to the user, and the fake database fails any request without a `user_id` filter). Moving the MCP queries to the user's own token so row-level security backs them up is worth doing but is **deferred**: it is a larger rewrite and the test round is five invited people. Revisit before any open sign-up.
- **Login abuse**: rely on Supabase Auth's built-in rate limits for the website; keep the existing delay on the Claude sign-in page; note CAPTCHA (Supabase supports Cloudflare Turnstile) as the next step if abuse appears.
- **Account deletion and export**: a Settings page "Download my data" (JSON, built in the browser from the user's own rows) and "Delete my account" (a small server function that confirms the password, deletes the auth user; all rows go with it through the existing `on delete cascade`). Needed because testers are putting real client and payment details in.
- **Privacy and terms**: a short plain-English page linked from the sign-up screen and Settings: what is stored, who can see it (only the owner, with database access), that it is a test, how to delete it, and that the owner may delete the whole test at the end.

### 6. Tester experience

- **Feedback**: a link in Settings and in the footer (`config.js`: `feedbackUrl`, an email or a form).
- **"What to try" page** for testers: a short checklist (add a client and project, record a payment, make an invoice, add a renewal, connect Claude and ask three questions) plus known gaps (no tax, no payments collection, no conversion between currencies).
- **Connecting Claude**: rewrite the connection steps in `docs/mcp.md` for someone who has never seen the project (what URL to paste, what the consent screen looks like, how to disconnect).
- **Errors**: the server already logs one line per request to Vercel; add a global browser error handler that shows a friendly message and a "copy details" button so testers can paste what went wrong.
- **Docs**: update `README.md` (no longer "single owner, sign-ups turned off", INR-only wording, owner steps for the allow-list and SMTP) and `CONTRIBUTING.md` ("Money is in rupees… owner is the only user" is no longer true).

## Order of work

Each step ships with its tests (this repo's rule), keeps the full suite green, and runs `supabase/schema.sql` twice on the live database before merging, as described in `CONTRIBUTING.md`.

1. **Schema**: `settings` columns, `projects.currency`, `clients.is_sample`, `allowed_emails` + sign-up trigger, currency check, and the `consistency.test.js` updates (including the deliberate `allowed_emails` exception to "every table has an own-rows policy").
2. **Server: currency, financial year, time zone** in `ledger.js`, `writes.js`, `tools.js`, with new tests: a US-style calendar-year user, a user in another time zone around midnight, mixed-currency totals, the currency lock, and the unchanged owner case.
3. **Website: the same changes**, the project currency picker, the dashboard currency switcher, and the **full Settings page** (section 0) with its Regional fields, with end-to-end tests.
4. **Sign-up gating and first-run screen**, with tests for invited/uninvited emails.
5. **Sample data** load and remove, in two currencies, with tests that remove leaves the real data untouched.
6. **Cross-tenant test expansion** and Supabase advisors on the live project.
7. **Account deletion, data export, privacy page, feedback link, error handler.**
8. **Docs**: README, `docs/mcp.md`, CONTRIBUTING, the testers' "what to try" page.
9. **Dry run**: the owner signs up with a second (invited) email, goes through the whole flow on the live site and in Claude, and fixes whatever breaks before any Reddit post goes out.

## Done when

- Settings is a full page reachable from every screen, and no settings pop-up remains.
- A new invited person can sign up, confirm their email, finish first-run, load sample data and see a populated dashboard in their own currency.
- They can create projects in different currencies and see correct per-currency totals; a US-style calendar financial year and a non-India time zone produce correct periods, invoice numbers and overdue dates.
- An uninvited email cannot create an account.
- No tester can see or change another user's data through the website or any Claude tool (tests prove it).
- The owner's existing data and behaviour are unchanged.
- Sample data can be removed without touching real data, and the button can be switched off from one flag.
- Full test suite is green in CI.

## Owner steps (not code)

- Create the SMTP account and paste its settings into Supabase Auth.
- Enable email sign-ups and confirmation, and set the site/redirect URLs, in the Supabase dashboard.
- Choose the feedback address for `config.js`.
- Add each tester's email to `allowed_emails` before telling them to sign up.
- Decide the date the test ends and what happens to testers' data then (the privacy page should state it).

## Out of scope for this round

Billing and plans, teams or agency seats, GST/TDS or any tax, currency conversion, languages other than English, moving MCP queries to row-level security, CAPTCHA, a landing page, a frontend rewrite, and anything for marketing-style agencies.

## Risks to watch

- **Mixed currencies are the biggest change.** Every total and every tool result has to be grouped correctly; the tests above exist because this is where wrong numbers could slip in.
- **Existing projects must default to INR**, or the owner's ledger changes meaning.
- **Email deliverability**: if confirmation emails don't arrive, testers can't get in. The dry run in step 9 must use a non-Gmail-to-Gmail path too if possible.
- **Same database as the owner's**: a mistake in a migration affects the owner's data. The "only add, never drop" rule in CONTRIBUTING covers this; keep following it.
