// The website in a real browser (Chromium via Playwright), with Supabase replaced by tests/e2e/fake-supabase-js.js.
// Run: node --test tests/e2e/   (needs Playwright; see tests/README.md)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { parse } = require('../helpers/schema');
const { Store } = require('../helpers/store');
const { seed, ids, OWNER } = require('../helpers/seed');

function loadPlaywright() {
  try { return require('playwright'); } catch (e) {}
  return require(path.join(execSync('npm root -g').toString().trim(), 'playwright'));
}
const { chromium } = loadPlaywright();

const ROOT = path.join(__dirname, '..', '..');
const SITE = 'https://ledger.test/';
const USERS = [{ id: OWNER, email: 'me@example.com', password: 'right password' }];
const FAKE_JS = ['tests/helpers/store.js', 'tests/e2e/fake-supabase-js.js'].map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
const QR_JS = fs.readFileSync(require.resolve('qrcode-generator/qrcode.js', { paths: [__dirname] }), 'utf8');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

let browser;
test.before(async () => { browser = await chromium.launch(); });
test.after(async () => { if (browser) await browser.close(); });

// Opens the site on a fresh page. Returns the page and the list of browser errors seen.
async function open(t, { signedIn = true, hash = '#/', viewport = { width: 1280, height: 900 }, colorScheme = 'light', period, now = '2026-10-23T12:00:00+05:30', missing = [] } = {}) {
  const context = await browser.newContext({ viewport, colorScheme, timezoneId: 'Asia/Kolkata', locale: 'en-IN' });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.clock.setFixedTime(new Date(now));
  const store = seed(new Store(parse()));
  missing.forEach(table => delete store.rows[table]); // as if supabase/schema.sql hadn't been re-run yet
  await page.addInitScript(init => {
    window.__LEDGER_TEST__ = init;
    if (init.period) localStorage.setItem('ledger.period', init.period);
  }, { schema: parse(), rows: store.rows, users: USERS, signedIn, period });
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith('https://cdn.jsdelivr.net/npm/@supabase/')) return route.fulfill({ contentType: 'text/javascript', body: FAKE_JS });
    if (url.startsWith('https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/')) return route.fulfill({ contentType: 'text/javascript', body: QR_JS }); // the real library, from npm
    if (!url.startsWith(SITE)) return route.fulfill({ status: 200, contentType: 'text/css', body: '' }); // fonts: no network in tests
    const file = path.join(ROOT, new URL(url).pathname.replace(/^\/$/, '/index.html'));
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: 'not found' });
    return route.fulfill({ contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
  });
  await page.goto(SITE + hash);
  t.after(() => assert.deepEqual(errors, [], 'the browser reported errors'));
  return page;
}

const kpi = (page, label) => page.locator('.kpi').filter({ has: page.locator('.eyebrow', { hasText: new RegExp('^' + label + '$') }) }).locator('.v');
const rows = (page, table) => page.evaluate(t => window.__store.rows[t], table);
const heading = page => page.locator('#view h1').first();

test('signing in and out', async t => {
  const page = await open(t, { signedIn: false });
  await page.fill('#l-email', 'me@example.com');
  await page.fill('#l-pass', 'wrong');
  await page.click('button:has-text("Sign in")');
  await page.waitForSelector('text=Wrong email or password.');
  await page.fill('#l-pass', 'right password');
  await page.click('button:has-text("Sign in")');
  await assert.doesNotReject(heading(page).filter({ hasText: 'Dashboard' }).waitFor());
  await page.click('#signout');
  await page.waitForSelector('#l-email');
  assert.equal(await page.locator('#tabs').isHidden(), true);
});

test('forgot password', async t => {
  const page = await open(t, { signedIn: false });
  await page.click('text=Forgot password?');
  await page.waitForSelector('text=Type your email first');
  await page.fill('#l-email', 'me@example.com');
  await page.click('text=Forgot password?');
  await page.waitForSelector('text=a reset link is on its way');
  const calls = await page.evaluate(() => window.__calls);
  assert.deepEqual(calls.at(-1), ['reset', 'me@example.com', SITE]);
});

test('dashboard numbers for all time and this month', async t => {
  const page = await open(t, { period: 'all' });
  await heading(page).filter({ hasText: 'Dashboard' }).waitFor();
  assert.equal(await kpi(page, 'Revenue').textContent(), '₹40,000');
  assert.equal(await kpi(page, 'Spending').textContent(), '₹1,500');
  assert.equal(await kpi(page, 'Profit').textContent(), '₹38,500');
  assert.equal(await kpi(page, 'Still to collect').textContent(), '₹30,000');
  assert.match(await kpi(page, 'Projects').locator('xpath=..').textContent(), /1 lead worth ₹80k/);
  await page.click('.pills button:has-text("This month")');
  assert.equal(await kpi(page, 'Revenue').textContent(), '₹20,000');
  assert.equal(await kpi(page, 'Spending').textContent(), '₹1,000');
  await page.waitForSelector('text=/no date/i');
  await page.click('.pills button:has-text("This year")');
  assert.equal(await kpi(page, 'Revenue').textContent(), '₹35,000');
  await page.click('.pills button:has-text("Last 12 months")');
  assert.equal(await kpi(page, 'Spending').textContent(), '₹1,500');
  assert.equal(await page.evaluate(() => localStorage.getItem('ledger.period')), '12m');
});

test('the financial year is the default period, and the pills cover every period', async t => {
  const page = await open(t);
  await heading(page).filter({ hasText: 'Dashboard' }).waitFor();
  assert.deepEqual(await page.locator('.pills button').allTextContents(), ['FY 2026–27', 'FY 2025–26', 'This month', 'Last 12 months', 'This year', 'All time']);
  assert.equal(await page.locator('.pills button[aria-pressed="true"]').textContent(), 'FY 2026–27');
  assert.equal(await page.locator('.pills button:has-text("FY 2026–27")').getAttribute('title'), 'This financial year');
  // Same totals as get_summary with this_fy and last_fy (see ledger.test.js).
  assert.equal(await kpi(page, 'Revenue').textContent(), '₹20,000');
  assert.equal(await kpi(page, 'Spending').textContent(), '₹1,000');
  await page.waitForSelector('text=/no date/i');
  assert.match(await page.locator('details.tbl').textContent(), /October 2026.*April 2026/s);
  assert.doesNotMatch(await page.locator('details.tbl').textContent(), /March 2026|November 2026/);
  await page.click('.pills button:has-text("FY 2025–26")');
  assert.equal(await kpi(page, 'Revenue').textContent(), '₹15,000');
  assert.equal(await kpi(page, 'Spending').textContent(), '₹500');
  assert.equal(await page.locator('details.tbl tbody tr').count(), 12);
  assert.equal(await page.evaluate(() => localStorage.getItem('ledger.period')), 'last_fy');
  await page.goto(SITE + '#/money');
  assert.equal(await page.locator('.pills button[aria-pressed="true"]', { hasText: 'FY' }).textContent(), 'FY 2025–26');
  assert.equal(await page.locator('#view .row').count(), 2);
});

test('31 March and 1 April land in different financial years', async t => {
  const march = await open(t, { now: '2027-03-31T23:30:00+05:30' });
  await heading(march).filter({ hasText: 'Dashboard' }).waitFor();
  assert.equal(await march.locator('.pills button[aria-pressed="true"]').textContent(), 'FY 2026–27');
  const april = await open(t, { now: '2027-04-01T00:10:00+05:30' });
  await heading(april).filter({ hasText: 'Dashboard' }).waitFor();
  assert.equal(await april.locator('.pills button[aria-pressed="true"]').textContent(), 'FY 2027–28');
  assert.equal(await kpi(april, 'Revenue').textContent(), '₹0');
  await april.click('.pills button:has-text("FY 2026–27")');
  assert.equal(await kpi(april, 'Revenue').textContent(), '₹20,000');
});

test('dashboard lists: still to collect, top projects, spending, recent money', async t => {
  const page = await open(t, { period: 'all' });
  const card = title => page.locator('.card').filter({ has: page.locator('h2', { hasText: title }) });
  await card('Still to collect').waitFor();
  assert.match(await card('Still to collect').textContent(), /Website.*GeekBoz.*₹20,000 of ₹50,000 paid.*₹30,000/);
  assert.match(await card('Most profitable projects').textContent(), /Website.*Edustudy.*₹20,000.*Website.*GeekBoz.*₹19,000/);
  assert.match(await card('Where the money went').textContent(), /Domain.*₹1,000.*Hosting.*₹500/);
  assert.equal(await card('Recent money').locator('.row').count(), 5);
  await page.click('text=Show as table');
  assert.ok(await card('Money in and out').locator('tbody tr').count() > 0);
});

test('a new project for a new client, then a payment on it', async t => {
  const page = await open(t);
  await page.click('button:has-text("+ New project")');
  await page.click('.sheet button:has-text("Add project")');
  await page.waitForSelector('text=Give the project a title.');
  await page.fill('#p-name', 'Booking site');
  await page.selectOption('#p-client', '__new__');
  await page.fill('#p-client-name', 'Sweet Crumbs');
  await page.fill('#p-quoted', '40000');
  await page.fill('#p-liveUrl', 'javascript:alert(1)');
  await page.click('.sheet button:has-text("Add project")');
  await page.waitForSelector('text=/link doesn’t look like a web address/');
  await page.fill('#p-liveUrl', 'sweetcrumbs.in');
  await page.click('.sheet button:has-text("Add project")');
  await heading(page).filter({ hasText: 'Booking site' }).waitFor();
  assert.match(page.url(), /#\/project\//);
  assert.equal(await kpi(page, 'Still to collect').textContent(), '₹40,000');
  const p = (await rows(page, 'projects')).find(x => x.name === 'Booking site');
  assert.deepEqual([Number(p.quoted), p.live_url, p.status, p.start_date], [40000, 'https://sweetcrumbs.in/', 'active', '2026-10-23']);
  assert.ok((await rows(page, 'clients')).some(c => c.name === 'Sweet Crumbs' && c.id === p.client_id));

  await page.click('button:has-text("+ Add money")');
  await page.click('.sheet button:has-text("Save")');
  await page.waitForSelector('text=Enter an amount above ₹0.');
  await page.fill('#m-amount', '10000');
  await page.fill('#m-note', 'Advance');
  await page.click('.sheet button:has-text("Save")');
  await page.locator('.sheet').waitFor({ state: 'detached' });
  assert.equal(await kpi(page, 'Received').textContent(), '₹10,000');
  assert.equal(await kpi(page, 'Still to collect').textContent(), '₹30,000');
  const tx = (await rows(page, 'txns')).find(x => x.project_id === p.id);
  assert.deepEqual([tx.type, Number(tx.amount), tx.date, tx.category], ['in', 10000, '2026-10-23', '']);
});

test('an expense with a new project from the money sheet', async t => {
  const page = await open(t, { hash: '#/money' });
  await page.click('button:has-text("+ Add money")');
  await page.click('.seg button:has-text("Money out")');
  await page.fill('#m-amount', '899');
  await page.selectOption('#m-client', ids.geekboz);
  await page.selectOption('#m-project', '__new__');
  await page.fill('#m-project-new', 'Hosting setup');
  await page.selectOption('#m-cat', 'Hosting');
  await page.click('.sheet button:has-text("Save")');
  await page.locator('.sheet').waitFor({ state: 'detached' });
  const p = (await rows(page, 'projects')).find(x => x.name === 'Hosting setup');
  const tx = (await rows(page, 'txns')).find(x => Number(x.amount) === 899);
  assert.deepEqual([tx.type, tx.category, tx.project_id, tx.client_id], ['out', 'Hosting', p.id, ids.geekboz]);
});

test('edit and delete a money entry', async t => {
  const page = await open(t, { hash: '#/money', period: 'all' });
  await page.click('button[aria-label="Edit Advance, ₹20,000"]');
  await page.fill('#m-amount', '25000');
  await page.click('.sheet button:has-text("Save changes")');
  await page.waitForSelector('button[aria-label="Edit Advance, ₹25,000"]');
  assert.equal(Number((await rows(page, 'txns')).find(x => x.id === ids.advance).amount), 25000);
  await page.click('button[aria-label="Edit Advance, ₹25,000"]');
  await page.click('.sheet button:has-text("Delete entry")');
  await page.click('.sheet button.danger:has-text("Delete entry")');
  await page.locator('.sheet').waitFor({ state: 'detached' });
  assert.ok(!(await rows(page, 'txns')).some(x => x.id === ids.advance));
  await page.click('.pills button:has-text("Money out")');
  assert.match(await page.locator('#view .sec .sub').first().textContent(), /2 entries/);
  await page.fill('input[aria-label="Search money"]', 'hostinger');
  assert.match(await page.locator('#view .sec .sub').first().textContent(), /1 entry/);
});

test('edit a project, then delete it (its money stays with the client)', async t => {
  const page = await open(t, { hash: '#/project/' + ids.gbSite });
  await page.click('#view button:has-text("Edit")');
  await page.selectOption('#p-status', 'done');
  await page.fill('#p-desc', 'Next.js site');
  await page.click('.sheet button:has-text("Save changes")');
  await page.waitForSelector('#view .prose:has-text("Next.js site")');
  assert.equal((await rows(page, 'projects')).find(x => x.id === ids.gbSite).status, 'done');
  await page.click('#view button:has-text("Edit")');
  await page.click('.sheet button:has-text("Delete project")');
  await page.waitForSelector('text=Its 2 money entries stay with GeekBoz');
  await page.waitForSelector('text=Its 3 milestones are deleted.');
  await page.click('.sheet button.danger');
  await heading(page).filter({ hasText: 'Projects' }).waitFor();
  const tx = (await rows(page, 'txns')).filter(x => [ids.advance, ids.domain].includes(x.id));
  assert.deepEqual(tx.map(x => x.project_id), [null, null]);
});

const card = (page, title) => page.locator('.card').filter({ has: page.locator('h2', { hasText: title }) });

test('milestones on the project page: paid, overdue, not paid yet; overdue shows on the cards', async t => {
  const page = await open(t, { hash: '#/project/' + ids.gbSite });
  const ms = card(page, 'Payment milestones');
  await ms.waitFor();
  const list = await ms.locator('.row').allTextContents();
  assert.equal(list.length, 3);
  assert.match(list[0], /Advance.*Due 1 Sept 2026.*₹20,000.*Paid/);
  assert.match(list[1], /Design.*Due 15 Oct 2026.*₹15,000.*Overdue/);
  assert.match(list[2], /Launch.*Due 28 Oct 2026.*₹15,000.*Not paid yet/);
  assert.match(await kpi(page, 'Still to collect').locator('xpath=..').textContent(), /₹15,000 overdue/);
  await page.goto(SITE + '#/projects');
  await page.click('.pills button:has-text("All")');
  const cardOf = name => page.locator('.pcard').filter({ has: page.locator('h3', { hasText: new RegExp('^' + name + '$') }) });
  assert.match(await cardOf('Website').first().textContent(), /₹15,000 overdue/);
  assert.doesNotMatch(await cardOf('App').textContent(), /overdue/); // a lead is never overdue
  await page.goto(SITE + '#/');
  assert.match(await card(page, 'Still to collect').textContent(), /₹15,000 overdue/);
});

const msAmounts = page => page.locator('.sheet .msrow input[type=number]').evaluateAll(els => els.map(e => e.value));
const msNames = page => page.locator('.sheet .msrow input:not([type])').evaluateAll(els => els.map(e => e.value));

test('the last milestone fills in the rest of the quote as you type, and new milestones go above it', async t => {
  const page = await open(t, { hash: '#/project/' + ids.eduSite }); // quoted ₹20,000, no milestones yet
  await page.click('#view button:has-text("Set up milestones")');
  assert.deepEqual(await msNames(page), ['Advance', 'Final payment']);
  assert.deepEqual(await msAmounts(page), ['', '20000']);
  assert.equal(await page.locator('.sheet [aria-label="Milestone 2 amount (₹)"]').getAttribute('readonly'), '');
  await page.locator('.sheet [aria-label="Milestone 1 amount (₹)"]').pressSequentially('50');
  assert.deepEqual(await msAmounts(page), ['50', '19950'], 'the rest updates on every keystroke');
  await page.locator('.sheet [aria-label="Milestone 1 amount (₹)"]').pressSequentially('00');
  assert.deepEqual(await msAmounts(page), ['5000', '15000']);
  await page.click('.sheet button:has-text("+ Add milestone")');
  assert.deepEqual(await msNames(page), ['Advance', '', 'Final payment'], 'the new milestone goes above the rest');
  assert.deepEqual(await msAmounts(page), ['5000', '', '15000']);
  await page.fill('.sheet [aria-label="Milestone 2 name"]', 'Design');
  await page.locator('.sheet [aria-label="Milestone 2 amount (₹)"]').pressSequentially('6000');
  assert.deepEqual(await msAmounts(page), ['5000', '6000', '9000']);
  assert.match(await page.locator('.sheet .total').textContent(), /Total ₹20,000 — matches the quote/);
  await page.fill('.sheet [aria-label="Milestone 3 due date"]', '2026-12-15');
  await page.click('.sheet button:has-text("Save milestones")');
  await page.waitForSelector('.sheet', { state: 'detached' });
  const saved = (await rows(page, 'milestones')).filter(m => m.project_id === ids.eduSite).sort((a, b) => a.sort_order - b.sort_order);
  assert.deepEqual(saved.map(m => [m.name, Number(m.amount), m.due_date]), [['Advance', 5000, null], ['Design', 6000, null], ['Final payment', 9000, '2026-12-15']]);
  // Opening it again: they add up to the quote, so the last one is still the rest.
  await page.click('#view button:has-text("Edit milestones")');
  await page.fill('.sheet [aria-label="Milestone 1 amount (₹)"]', '2000');
  assert.deepEqual(await msAmounts(page), ['2000', '6000', '12000']);
});

test('quick splits; when the others cover the quote the rest is ₹0 and isn\'t saved', async t => {
  const page = await open(t, { hash: '#/project/' + ids.gbSite });
  await page.click('#view button:has-text("Edit milestones")');
  assert.deepEqual(await msAmounts(page), ['20000', '15000', '15000']);
  await page.click('.sheet button:has-text("50 / 30 / 20")');
  assert.deepEqual(await msNames(page), ['Advance', 'Payment 2', 'Final payment']);
  assert.deepEqual(await msAmounts(page), ['25000', '15000', '10000']);
  assert.match(await page.locator('.sheet .total').textContent(), /Total ₹50,000 — matches the quote/);
  await page.fill('.sheet [aria-label="Milestone 1 amount (₹)"]', '40000');
  await page.fill('.sheet [aria-label="Milestone 2 amount (₹)"]', '15000');
  assert.deepEqual(await msAmounts(page), ['40000', '15000', '0']);
  await page.waitForSelector('.sheet .msrow.none:has-text("won’t be saved")');
  assert.match(await page.locator('.sheet .total.warn').textContent(), /Total ₹55,000 — ₹5,000 more than the ₹50,000 quote/);
  await page.fill('.sheet [aria-label="Milestone 1 due date"]', '2026-11-01');
  await page.click('.sheet button:has-text("Save milestones")');
  await page.waitForSelector('.sheet', { state: 'detached' });
  const saved = (await rows(page, 'milestones')).filter(m => m.project_id === ids.gbSite).sort((a, b) => a.sort_order - b.sort_order);
  assert.deepEqual(saved.map(m => [m.name, Number(m.amount), m.due_date]), [['Advance', 40000, '2026-11-01'], ['Payment 2', 15000, '2026-10-15']]); // a quick split keeps the due dates already set
  assert.ok(!saved.some(m => m.id === ids.msDesign), 'the old milestones are replaced');
  await page.waitForSelector('text=The milestones add up to ₹55,000, but the quote is ₹50,000.');
  // They no longer add up to the quote, so every amount can be typed again.
  await page.click('#view button:has-text("Edit milestones")');
  assert.equal(await page.locator('.sheet input[readonly]').count(), 0);
});

test('custom milestones, refusing an empty amount, then removing them all', async t => {
  const page = await open(t, { hash: '#/project/' + ids.eduSite });
  await page.click('#view button:has-text("Set up milestones")');
  await page.fill('.sheet [aria-label="Milestone 1 amount (₹)"]', '20000');
  await page.click('.sheet button:has-text("+ Add milestone")');
  await page.click('.sheet button:has-text("Save milestones")');
  await page.waitForSelector('text=Milestone 2 needs an amount above ₹0.');
  assert.equal((await rows(page, 'milestones')).filter(m => m.project_id === ids.eduSite).length, 0);
  await page.click('.sheet .msrow:nth-child(2) button:has-text("Remove")');
  await page.fill('.sheet [aria-label="Milestone 1 name"]', 'Everything');
  await page.click('.sheet button:has-text("Save milestones")');
  await page.waitForSelector('.sheet', { state: 'detached' });
  assert.match(await card(page, 'Payment milestones').textContent(), /Everything.*₹20,000.*Paid/); // ₹20,000 received; the ₹0 rest isn't saved
  await page.click('#view button:has-text("Edit milestones")');
  await page.click('.sheet .msrow button:has-text("Remove")');
  assert.match(await page.locator('.sheet .total').textContent(), /Saving removes them all/);
  await page.click('.sheet button:has-text("Save milestones")');
  await page.waitForSelector('#view button:has-text("Set up milestones")');
  assert.equal((await rows(page, 'milestones')).filter(m => m.project_id === ids.eduSite).length, 0);
});

test('without a quote, every amount is typed by hand', async t => {
  const page = await open(t, { hash: '#/project/' + ids.eduSite });
  await page.click('#view .page-head button:has-text("Edit")');
  await page.fill('#p-quoted', '');
  await page.click('.sheet button:has-text("Save changes")');
  await page.waitForSelector('.sheet', { state: 'detached' });
  await page.click('#view button:has-text("Set up milestones")');
  assert.deepEqual(await msAmounts(page), ['']);
  assert.equal(await page.locator('.sheet input[readonly]').count(), 0);
  assert.equal(await page.locator('.sheet button:has-text("50 / 50")').isDisabled(), true);
  await page.fill('.sheet [aria-label="Milestone 1 amount (₹)"]', '7000');
  await page.click('.sheet button:has-text("+ Add milestone")');
  assert.deepEqual(await msAmounts(page), ['7000', '']);
  assert.match(await page.locator('.sheet .total').textContent(), /^Total ₹7,000$/);
});

// ---------- invoices ----------
const UPI_002 = 'upi://pay?pa=mec%40okhdfcbank&pn=Mec%20Web%20Studio&am=15000.00&cu=INR&tn=INV%2F2026-27%2F002';
const invRow = async (page, number) => (await rows(page, 'invoices')).find(i => i.number === number && i.user_id === OWNER);

test('invoices tab: what each client owes, and filters', async t => {
  const page = await open(t, { hash: '#/invoices' });
  await heading(page).filter({ hasText: 'Invoices' }).waitFor();
  assert.match(await card(page, 'To collect on invoices').textContent(), /₹15,000.*GeekBoz.*1 invoice · 8 days overdue.*₹15,000/);
  const listed = () => page.locator('#view > .list .row .title').allTextContents();
  assert.deepEqual(await listed(), ['INV/2026-27/002 · GeekBoz']);
  assert.deepEqual(await page.locator('.pills[aria-label="Invoices"] button').allTextContents(), ['Unpaid 1', 'Overdue 1', 'Drafts 1', 'Paid 2', 'Cancelled 1', 'All 5']);
  await page.locator('.pills[aria-label="Invoices"] button', { hasText: /^Paid / }).click();
  assert.deepEqual(await listed(), ['INV/2026-27/001 · GeekBoz', 'INV/2025-26/001 · Edustudy']);
  await page.click('.pills[aria-label="Invoices"] button:has-text("Cancelled")');
  assert.match(await page.locator('#view > .list').textContent(), /INV\/2025-26\/002.*₹5,000.*Cancelled/);
  await page.goto(SITE + '#/');
  assert.match(await card(page, 'To collect on invoices').textContent(), /GeekBoz.*8 days overdue/);
});

test('an invoice page: details, amount due, UPI QR code and link, bank details', async t => {
  const page = await open(t, { hash: '#/invoice/' + ids.invDesign });
  const doc = page.locator('.invoice');
  await doc.waitFor();
  const text = await doc.textContent();
  for (const bit of ['Mec Web Studio', '12 MG Road, Kochi', 'INV/2026-27/002', 'GeekBoz', '98765 43210', 'Project: Website', '8 Oct 2026', '15 Oct 2026', 'Website — Design', 'Amount due₹15,000', 'UPI: mec@okhdfcbank', 'IFSC HDFC0001234', 'Scan to pay ₹15,000'])
    assert.ok(text.includes(bit), 'the invoice should show ' + bit);
  assert.equal(await page.locator('.invoice .qr svg').getAttribute('data-upi'), UPI_002);
  assert.ok(await page.locator('.invoice .qr svg path').getAttribute('d'), 'the QR code is drawn');
  assert.equal(await page.locator('.invoice a:has-text("UPI app")').getAttribute('href'), UPI_002);
  assert.match(await page.locator('#view .page-head').textContent(), /Overdue/);
  await page.waitForSelector('text=Reminded 1 time, last on 18 Oct 2026.');
  // A paid invoice has no QR code and says Paid.
  await page.goto(SITE + '#/invoice/' + ids.invAdvance);
  await page.locator('.invoice .stamp.paid').waitFor();
  assert.equal(await page.locator('.invoice .qr').count(), 0);
  assert.match(await page.locator('.card:has(h2:has-text("Payments"))').textContent(), /Advance.*₹20,000/);
});

test('invoice a milestone: numbered, due after the payment terms, linked on the project page', async t => {
  const page = await open(t, { hash: '#/project/' + ids.gbSite });
  const ms = card(page, 'Payment milestones');
  assert.match(await ms.locator('.row').nth(1).textContent(), /INV\/2026-27\/002/); // Design is already invoiced
  await ms.locator('.row').nth(2).locator('button:has-text("Invoice this")').click();
  assert.match(await page.locator('.sheet').textContent(), /Invoice INV\/2026-27\/004 · for the Launch milestone/);
  assert.equal(await page.inputValue('#i-due'), '2026-10-30');
  assert.equal(await page.inputValue('.sheet [aria-label="Item 1 description"]'), 'Website — Launch');
  assert.match(await page.locator('.sheet .total').textContent(), /Total ₹15,000/);
  await page.click('.sheet button:has-text("Create invoice")');
  await heading(page).filter({ hasText: 'INV/2026-27/004' }).waitFor();
  const row = await invRow(page, 'INV/2026-27/004');
  assert.deepEqual([row.client_id, row.project_id, row.milestone_id, row.status, Number(row.total), row.notes, row.issue_date, row.due_date],
    [ids.geekboz, ids.gbSite, ids.msLaunch, 'draft', 15000, 'Thank you!', '2026-10-23', '2026-10-30']);
  await page.goto(SITE + '#/project/' + ids.gbSite);
  assert.match(await card(page, 'Payment milestones').locator('.row').nth(2).textContent(), /INV\/2026-27\/004/);
});

test('a new invoice from line items; the number follows the issue date across 1 April', async t => {
  const page = await open(t, { hash: '#/invoices' });
  await page.click('#view button:has-text("+ New invoice")');
  await page.selectOption('#i-client', ids.edustudy);
  await page.fill('.sheet [aria-label="Item 1 description"]', 'Logo design');
  await page.fill('.sheet [aria-label="Item 1 rate (₹)"]', '3000');
  await page.click('.sheet button:has-text("+ Add item")');
  await page.fill('.sheet [aria-label="Item 2 quantity"]', '3');
  await page.fill('.sheet [aria-label="Item 2 rate (₹)"]', '1500');
  assert.match(await page.locator('.sheet .total').textContent(), /Total ₹7,500/);
  await page.click('.sheet button:has-text("Create invoice")');
  await page.waitForSelector('text=Item 2 needs a description.');
  await page.fill('.sheet [aria-label="Item 2 description"]', 'Extra pages');
  await page.fill('#i-issue', '2027-04-01');
  assert.equal(await page.inputValue('#i-due'), '2027-04-08');
  assert.match(await page.locator('.sheet').textContent(), /Invoice INV\/2027-28\/001/);
  await page.click('.sheet button:has-text("Create invoice")');
  await heading(page).filter({ hasText: 'INV/2027-28/001' }).waitFor();
  const row = await invRow(page, 'INV/2027-28/001');
  assert.deepEqual(row.items, [{ description: 'Logo design', quantity: 1, rate: 3000 }, { description: 'Extra pages', quantity: 3, rate: 1500 }]);
  assert.deepEqual([Number(row.total), row.project_id, row.status], [7500, null, 'draft']);
  // Editing keeps the number.
  await page.click('#view .page-head button:has-text("Edit")');
  await page.fill('.sheet [aria-label="Item 1 rate (₹)"]', '4000');
  await page.click('.sheet button:has-text("Save changes")');
  await page.waitForSelector('.sheet', { state: 'detached' });
  assert.deepEqual([Number((await invRow(page, 'INV/2027-28/001')).total), (await rows(page, 'invoices')).filter(i => i.user_id === OWNER).length], [8500, 6]);
});

test('mark a draft as sent, record payments for it, and it becomes paid', async t => {
  const page = await open(t, { hash: '#/invoice/' + ids.invDraft });
  await page.click('#view button:has-text("Mark sent")');
  await page.locator('#view .page-head .state.unpaid').waitFor();
  assert.ok((await invRow(page, 'INV/2026-27/003')).sent_at);
  await page.click('#view button:has-text("Record payment")');
  assert.match(await page.locator('.sheet .notice').textContent(), /Payment for invoice INV\/2026-27\/003/);
  assert.equal(await page.inputValue('#m-amount'), '2500');
  await page.fill('#m-amount', '1000');
  await page.click('.sheet button:has-text("Save")');
  await page.locator('#view .page-head .state.part-paid').waitFor();
  assert.match(await page.locator('.invoice tfoot').textContent(), /Paid−₹1,000.*Amount due₹1,500/);
  await page.click('#view button:has-text("Record payment")');
  assert.equal(await page.inputValue('#m-amount'), '1500');
  await page.click('.sheet button:has-text("Save")');
  await page.locator('.invoice .stamp.paid').waitFor();
  const pays = (await rows(page, 'txns')).filter(x => x.invoice_id === ids.invDraft);
  assert.deepEqual(pays.map(x => [x.type, Number(x.amount), x.client_id, x.project_id]), [['in', 1000, ids.edustudy, null], ['in', 1500, ids.edustudy, null]]);
  assert.equal(await page.locator('#view button:has-text("Record payment")').count(), 0);
});

test('remind a client: the message gets firmer, WhatsApp opens with it, then mark as reminded', async t => {
  const page = await open(t, { hash: '#/invoice/' + ids.invDesign });
  await page.click('#view button:has-text("Remind")');
  const msg = await page.inputValue('#r-text');
  assert.match(msg, /^Hi GeekBoz,\n\nInvoice INV\/2026-27\/002 for ₹15,000 was due on 15 Oct 2026 and is now 8 days overdue\./);
  assert.match(msg, /You can pay by UPI to mec@okhdfcbank\./);
  assert.match(msg, /Thank you,\nMec Web Studio$/);
  assert.equal(await page.getAttribute('#r-wa', 'href'), 'https://wa.me/919876543210?text=' + encodeURIComponent(msg));
  await page.fill('#r-text', 'Hi, please pay INV/2026-27/002 today.');
  assert.equal(await page.getAttribute('#r-wa', 'href'), 'https://wa.me/919876543210?text=' + encodeURIComponent('Hi, please pay INV/2026-27/002 today.'));
  await page.click('.sheet button:has-text("Mark as reminded")');
  await page.waitForSelector('text=Reminded 2 times, last on 23 Oct 2026.');
  const row = await invRow(page, 'INV/2026-27/002');
  assert.deepEqual([row.reminder_count, row.last_reminded], [2, '2026-10-23']);
});

test('reminder tone: friendly before a week, a payment date after a month, and no WhatsApp without a number', async t => {
  const early = await open(t, { hash: '#/invoice/' + ids.invDesign, now: '2026-10-18T12:00:00+05:30' });
  await early.click('#view button:has-text("Remind")');
  assert.match(await early.inputValue('#r-text'), /This is a friendly reminder that invoice INV\/2026-27\/002 for ₹15,000 was due on 15 Oct 2026\./);
  const late = await open(t, { hash: '#/invoice/' + ids.invDesign, now: '2026-11-30T12:00:00+05:30' });
  await late.click('#view button:has-text("Remind")');
  assert.match(await late.inputValue('#r-text'), /is now 46 days overdue\. Please make the payment by 7 Dec 2026, or reply with the date you will pay it\./);
  const edu = await open(t, { hash: '#/invoice/' + ids.invDraft });
  await edu.click('#view button:has-text("Mark sent")');
  await edu.click('#view button:has-text("Remind")');
  await edu.waitForSelector('text=Add a phone number to Edustudy’s contact to send it on WhatsApp.');
  assert.equal(await edu.locator('#r-wa').count(), 0);
});

test('cancel an invoice: never owed, number kept; reopen it', async t => {
  const page = await open(t, { hash: '#/invoice/' + ids.invDesign });
  await page.click('#view button:has-text("Cancel invoice")');
  await page.click('.sheet button.danger');
  await page.locator('.invoice .stamp.cancelled').waitFor();
  assert.equal((await invRow(page, 'INV/2026-27/002')).status, 'cancelled');
  assert.equal(await page.locator('.invoice .qr').count(), 0);
  assert.equal(await page.locator('#view button:has-text("Record payment")').count(), 0);
  await page.goto(SITE + '#/invoices');
  assert.equal(await card(page, 'To collect on invoices').count(), 0);
  await page.goto(SITE + '#/invoice/' + ids.invDesign);
  await page.click('#view button:has-text("Reopen as a draft")');
  await page.locator('#view .page-head .state.draft').waitFor();
});

test('your business details: added the first time, checked, and shown on invoices', async t => {
  const page = await open(t, { hash: '#/invoices', missing: ['settings'] });
  await page.waitForSelector('text=Add your business name and UPI ID so invoices show who to pay.');
  await page.goto(SITE + '#/invoice/' + ids.invDesign);
  assert.equal(await page.locator('.invoice .qr').count(), 0); // no UPI ID yet
  await page.click('#view button:has-text("Add your details")');
  await page.fill('#s-name', 'Mec Studio');
  await page.fill('#s-upi', 'not a upi');
  await page.click('.sheet button:has-text("Save details")');
  await page.waitForSelector('text=The UPI ID doesn’t look right.');
  await page.fill('#s-upi', 'mec@ybl');
  await page.fill('#s-terms', '15');
  await page.click('.sheet button:has-text("Save details")');
  await page.waitForSelector('text=The database is missing new tables or fields.'); // the table doesn't exist in this test
});

test('business details save, and set the terms for new invoices', async t => {
  const page = await open(t, { hash: '#/invoices' });
  await page.click('#view button:has-text("Your details")');
  assert.equal(await page.inputValue('#s-upi'), 'mec@okhdfcbank');
  await page.fill('#s-terms', '15');
  await page.fill('#s-prefix', 'MEC');
  await page.click('.sheet button:has-text("Save details")');
  await page.waitForSelector('.sheet', { state: 'detached' });
  const st = (await rows(page, 'settings')).find(r => r.user_id === OWNER);
  assert.deepEqual([st.payment_terms_days, st.invoice_prefix, st.business_name], [15, 'MEC', 'Mec Web Studio']);
  await page.click('#view button:has-text("+ New invoice")');
  assert.equal(await page.inputValue('#i-due'), '2026-11-07');
  assert.match(await page.locator('.sheet').textContent(), /Invoice MEC\/2026-27\/001/);
});

test('an invoice prints on one A4 page, without the app around it', async t => {
  const page = await open(t, { hash: '#/invoice/' + ids.invDesign });
  await page.locator('.invoice .qr svg').waitFor();
  await page.emulateMedia({ media: 'print' });
  assert.equal(await page.locator('.top').isVisible(), false);
  assert.equal(await page.locator('#view .page-head').isVisible(), false);
  assert.equal(await page.locator('.invoice').isVisible(), true);
  const pdf = (await page.pdf({ format: 'A4', preferCSSPageSize: true })).toString('latin1');
  assert.equal((pdf.match(/\/Type\s*\/Page[^s]/g) || []).length, 1, 'the invoice should fit on one A4 page');
});

test('the site still works before the invoices tables exist', async t => {
  const page = await open(t, { hash: '#/invoices', missing: ['invoices', 'settings'] });
  await page.waitForSelector('text=No invoices yet.');
  await page.goto(SITE + '#/project/' + ids.gbSite);
  await card(page, 'Payment milestones').waitFor();
  assert.equal(await kpi(page, 'Still to collect').textContent(), '₹30,000');
});

test('the site still works before the milestones table exists', async t => {
  const page = await open(t, { hash: '#/project/' + ids.gbSite, missing: ['milestones'] });
  await card(page, 'Payment milestones').waitFor();
  assert.equal(await kpi(page, 'Still to collect').textContent(), '₹30,000');
  await page.click('#view button:has-text("Set up milestones")');
  await page.fill('.sheet [aria-label="Milestone 1 amount (₹)"]', '20000');
  await page.click('.sheet button:has-text("Save milestones")');
  await page.waitForSelector('text=Run supabase/schema.sql');
});

// ---------- boards ----------
const column = (page, label) => page.locator('.board .bcol[aria-label="' + label + '"]');
const cardTitles = (page, label) => column(page, label).locator('.bcard .title').allTextContents();

test('projects board: drag a project to another status, or use Move to; the view is remembered', async t => {
  const page = await open(t, { hash: '#/projects' });
  await page.click('.view-pills button:has-text("Board")');
  await page.locator('.board').waitFor();
  assert.equal(await page.locator('.pills[aria-label="Status"]').count(), 0, 'the board shows every status, so no status filter');
  assert.deepEqual(await page.locator('.board .bcol .bhead').allTextContents(), ['Lead1', 'In progress1', 'On hold0', 'Done1']);
  assert.deepEqual(await cardTitles(page, 'Lead'), ['App']);
  assert.match(await column(page, 'In progress').textContent(), /Website.*GeekBoz · ₹20,000 of ₹50,000 paid.*₹15,000 overdue/);
  await page.dragAndDrop('.bcard:has-text("App")', '.board .bcol[aria-label="In progress"]');
  await page.waitForFunction(id => window.__store.rows.projects.find(p => p.id === id).status === 'active', ids.eduApp);
  assert.deepEqual((await cardTitles(page, 'In progress')).sort(), ['App', 'Website']);
  await page.selectOption('select[aria-label="Move App to"]', 'paused');
  await page.waitForFunction(id => window.__store.rows.projects.find(p => p.id === id).status === 'paused', ids.eduApp);
  assert.deepEqual(await cardTitles(page, 'On hold'), ['App']);
  assert.deepEqual(await page.locator('select[aria-label="Move App to"] option').allTextContents(), ['Move to…', 'Lead', 'In progress', 'Done']);
  await page.fill('input[aria-label="Search projects"]', 'geekboz');
  assert.deepEqual(await page.locator('.board .bcard .title').allTextContents(), ['Website']);
  await page.reload();
  await page.locator('.board').waitFor(); // still the board after reloading
  await page.click('.view-pills button:has-text("List")');
  await page.locator('.pgrid').waitFor();
});

test('invoices board: Draft, Sent, Paid, Cancelled; moving to Paid records a payment', async t => {
  const page = await open(t, { hash: '#/invoices' });
  await page.click('.view-pills button:has-text("Board")');
  await page.locator('.board').waitFor();
  assert.deepEqual(await page.locator('.board .bcol .bhead').allTextContents(), ['Draft₹2,500', 'Sent₹15,000', 'Paid₹35,000', 'Cancelled₹0']);
  assert.deepEqual(await cardTitles(page, 'Sent'), ['INV/2026-27/002']);
  assert.match(await column(page, 'Sent').textContent(), /8 days overdue/);
  assert.deepEqual(await cardTitles(page, 'Paid'), ['INV/2026-27/001', 'INV/2025-26/001']);
  // Payments cover a paid invoice, so it can't be moved back.
  assert.equal(await column(page, 'Paid').locator('select').count(), 0);
  await page.dragAndDrop('.bcard:has-text("INV/2026-27/001")', '.board .bcol[aria-label="Draft"]');
  assert.equal((await invRow(page, 'INV/2026-27/001')).status, 'sent');
  // Draft → Sent by dragging.
  await page.dragAndDrop('.bcard:has-text("INV/2026-27/003")', '.board .bcol[aria-label="Sent"]');
  await page.waitForFunction(id => window.__store.rows.invoices.find(i => i.id === id).status === 'sent', ids.invDraft);
  assert.ok((await invRow(page, 'INV/2026-27/003')).sent_at);
  assert.deepEqual(await cardTitles(page, 'Sent'), ['INV/2026-27/002', 'INV/2026-27/003']); // most overdue first
  // Sent → Paid opens Record payment for the amount due.
  await page.selectOption('select[aria-label="Move INV/2026-27/003 to"]', 'paid');
  assert.match(await page.locator('.sheet .notice').textContent(), /Payment for invoice INV\/2026-27\/003/);
  assert.equal(await page.inputValue('#m-amount'), '2500');
  await page.click('.sheet button:has-text("Save")');
  await page.waitForSelector('.sheet', { state: 'detached' });
  assert.deepEqual(await cardTitles(page, 'Paid'), ['INV/2026-27/003', 'INV/2026-27/001', 'INV/2025-26/001']);
  // Sent → Cancelled, and back to Sent.
  await page.selectOption('select[aria-label="Move INV/2026-27/002 to"]', 'cancelled');
  await page.waitForFunction(id => window.__store.rows.invoices.find(i => i.id === id).status === 'cancelled', ids.invDesign);
  assert.deepEqual(await page.locator('select[aria-label="Move INV/2026-27/002 to"] option').allTextContents(), ['Move to…', 'Draft', 'Sent']);
  await page.dragAndDrop('.bcard:has-text("INV/2026-27/002")', '.board .bcol[aria-label="Sent"]');
  await page.waitForFunction(id => window.__store.rows.invoices.find(i => i.id === id).status === 'sent', ids.invDesign);
});

test('projects: filters and search', async t => {
  const page = await open(t, { hash: '#/projects' });
  await page.waitForSelector('.pcard');
  assert.equal(await page.locator('.pcard').count(), 2); // Open = everything but Done
  await page.click('.pills button:has-text("All")');
  assert.equal(await page.locator('.pcard').count(), 3);
  await page.click('.pills button:has-text("Lead")');
  assert.deepEqual(await page.locator('.pcard h3').allTextContents(), ['App']);
  await page.click('.pills button:has-text("All")');
  await page.fill('input[aria-label="Search projects"]', 'geekboz');
  assert.equal(await page.locator('.pcard').count(), 1);
});

test('clients: add, edit, and delete with everything', async t => {
  const page = await open(t, { hash: '#/clients' });
  await page.click('button:has-text("+ New client")');
  await page.fill('#c-name', 'Sweet Crumbs');
  await page.click('.sheet button:has-text("Add client")');
  await heading(page).filter({ hasText: 'Sweet Crumbs' }).waitFor();
  await page.click('#view button:has-text("Edit")');
  await page.fill('#c-notes', 'Bakery in Pune');
  await page.click('.sheet button:has-text("Save changes")');
  await page.waitForSelector('#view .prose:has-text("Bakery in Pune")');
  await page.goto(SITE + '#/client/' + ids.edustudy);
  await heading(page).filter({ hasText: 'Edustudy' }).waitFor();
  assert.equal(await kpi(page, 'Revenue').textContent(), '₹20,000');
  await page.click('#view button:has-text("Edit")');
  await page.click('.sheet button:has-text("Delete client")');
  await page.waitForSelector('text=This also deletes their 2 projects, 3 money entries and 3 invoices');
  await page.click('.sheet button.danger');
  await heading(page).filter({ hasText: 'Clients' }).waitFor();
  assert.ok(!(await rows(page, 'projects')).some(x => x.client_id === ids.edustudy));
  assert.ok(!(await rows(page, 'txns')).some(x => x.client_id === ids.edustudy));
});

test('Escape and Cancel close a sheet without saving', async t => {
  const page = await open(t, { hash: '#/clients' });
  const before = await rows(page, 'clients');
  await page.click('button:has-text("+ New client")');
  await page.fill('#c-name', 'Never saved');
  await page.keyboard.press('Escape');
  await page.locator('.sheet').waitFor({ state: 'detached' });
  await page.click('button:has-text("+ New client")');
  await page.click('.sheet button:has-text("Cancel")');
  assert.deepEqual(await rows(page, 'clients'), before);
});

test('unknown pages go back to a list', async t => {
  const page = await open(t, { hash: '#/project/does-not-exist' });
  await heading(page).filter({ hasText: 'Projects' }).waitFor();
  await page.goto(SITE + '#/nonsense');
  await heading(page).filter({ hasText: 'Dashboard' }).waitFor();
});

for (const colorScheme of ['light', 'dark']) {
  test('every page fits a phone screen (' + colorScheme + ')', async t => {
    const page = await open(t, { viewport: { width: 375, height: 800 }, colorScheme });
    for (const hash of ['#/', '#/projects', '#/clients', '#/money', '#/invoices', '#/invoice/' + ids.invDesign, '#/project/' + ids.gbSite, '#/client/' + ids.edustudy]) {
      await page.goto(SITE + hash);
      await page.locator('#view h1').first().waitFor();
      const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
      assert.ok(scroll <= width, hash + ' scrolls sideways on a phone (' + scroll + 'px > ' + width + 'px)');
    }
    for (const hash of ['#/projects', '#/invoices']) {
      await page.goto(SITE + hash);
      await page.click('.view-pills button:has-text("Board")');
      await page.locator('.board').waitFor();
      const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
      assert.ok(scroll <= width, hash + ' board scrolls the page sideways on a phone');
      const first = await page.locator('.board .bcol').first().boundingBox();
      assert.ok(first.x >= 0 && first.x + first.width <= 375, hash + ' board column is wider than the phone');
    }
    await page.goto(SITE + '#/invoices');
    await heading(page).filter({ hasText: 'Invoices' }).waitFor();
    const tab = await page.locator('#tabs a[aria-current]').boundingBox();
    assert.ok(tab && tab.x >= 0 && tab.x + tab.width <= 375, 'the current tab is scrolled into view');
    await page.goto(SITE + '#/');
    await page.click('#view button:has-text("+ Add money")');
    const box = await page.locator('.sheet').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 375, 'the add-money sheet is wider than the phone');
    await page.keyboard.press('Escape');
    await page.goto(SITE + '#/project/' + ids.gbSite);
    await page.click('#view button:has-text("Edit milestones")');
    const ms = await page.locator('.sheet').boundingBox();
    assert.ok(ms.x >= 0 && ms.x + ms.width <= 375, 'the milestones sheet is wider than the phone');
    assert.ok(await page.locator('.sheet').evaluate(el => el.scrollWidth <= el.clientWidth), 'the milestones sheet scrolls sideways');
    for (const [hash, button] of [['#/invoices', '+ New invoice'], ['#/invoices', 'Your details'], ['#/invoice/' + ids.invDesign, 'Remind']]) {
      await page.keyboard.press('Escape');
      await page.goto(SITE + hash);
      await page.click('#view button:has-text("' + button + '")');
      const box = await page.locator('.sheet').boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= 375, 'the ' + button + ' sheet is wider than the phone');
      assert.ok(await page.locator('.sheet').evaluate(el => el.scrollWidth <= el.clientWidth), 'the ' + button + ' sheet scrolls sideways');
    }
  });
}
