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

test('set milestones with a quick split; warn when they don\'t add up to the quote', async t => {
  const page = await open(t, { hash: '#/project/' + ids.gbSite });
  await page.click('#view button:has-text("Edit milestones")');
  const amounts = () => page.locator('.sheet .msrow input[type=number]').evaluateAll(els => els.map(e => e.value));
  assert.deepEqual(await amounts(), ['20000', '15000', '15000']);
  await page.click('.sheet button:has-text("50 / 30 / 20")');
  assert.deepEqual(await amounts(), ['25000', '15000', '10000']);
  assert.deepEqual(await page.locator('.sheet .msrow input:not([type])').evaluateAll(els => els.map(e => e.value)), ['Advance', 'Payment 2', 'Final payment']);
  assert.match(await page.locator('.sheet .total').textContent(), /Total ₹50,000 — matches the quote/);
  await page.fill('.sheet [aria-label="Milestone 3 amount (₹)"]', '5000');
  assert.match(await page.locator('.sheet .total').textContent(), /Total ₹45,000 — the quote is ₹50,000/);
  assert.equal(await page.locator('.sheet .total.warn').count(), 1);
  await page.fill('.sheet [aria-label="Milestone 1 due date"]', '2026-11-01');
  await page.click('.sheet button:has-text("Save milestones")');
  await page.waitForSelector('.sheet', { state: 'detached' });
  const saved = (await rows(page, 'milestones')).filter(m => m.project_id === ids.gbSite).sort((a, b) => a.sort_order - b.sort_order);
  assert.deepEqual(saved.map(m => [m.name, Number(m.amount), m.due_date]), [['Advance', 25000, '2026-11-01'], ['Payment 2', 15000, '2026-10-15'], ['Final payment', 5000, '2026-10-28']]); // a quick split keeps the due dates already set
  assert.ok(!saved.some(m => m.id === ids.msDesign), 'the old milestones are replaced');
  await page.waitForSelector('text=The milestones add up to ₹45,000, but the quote is ₹50,000.');
  assert.match(await card(page, 'Payment milestones').locator('.row').first().textContent(), /₹20,000 of ₹25,000 paid.*Part paid/);
});

test('custom milestones, refusing an empty amount, then removing them all', async t => {
  const page = await open(t, { hash: '#/project/' + ids.eduSite });
  await page.click('#view button:has-text("Set up milestones")');
  assert.deepEqual(await page.locator('.sheet .msrow input[type=number]').evaluateAll(els => els.map(e => e.value)), ['10000', '10000']); // 50/50 of the ₹20,000 quote
  await page.click('.sheet button:has-text("Custom")');
  await page.fill('.sheet [aria-label="Milestone 1 name"]', 'Everything');
  await page.click('.sheet button:has-text("+ Add milestone")');
  await page.fill('.sheet [aria-label="Milestone 1 amount (₹)"]', '20000');
  await page.click('.sheet button:has-text("Save milestones")');
  await page.waitForSelector('text=Milestone 2 needs an amount above ₹0.');
  assert.equal((await rows(page, 'milestones')).filter(m => m.project_id === ids.eduSite).length, 0);
  await page.click('.sheet .msrow:nth-child(2) button:has-text("Remove")');
  await page.click('.sheet button:has-text("Save milestones")');
  await page.waitForSelector('.sheet', { state: 'detached' });
  assert.match(await card(page, 'Payment milestones').textContent(), /Everything.*₹20,000.*Paid/); // ₹20,000 received
  await page.click('#view button:has-text("Edit milestones")');
  await page.click('.sheet .msrow button:has-text("Remove")');
  assert.match(await page.locator('.sheet .total').textContent(), /Saving removes them all/);
  await page.click('.sheet button:has-text("Save milestones")');
  await page.waitForSelector('#view button:has-text("Set up milestones")');
  assert.equal((await rows(page, 'milestones')).filter(m => m.project_id === ids.eduSite).length, 0);
});

test('the site still works before the milestones table exists', async t => {
  const page = await open(t, { hash: '#/project/' + ids.gbSite, missing: ['milestones'] });
  await card(page, 'Payment milestones').waitFor();
  assert.equal(await kpi(page, 'Still to collect').textContent(), '₹30,000');
  await page.click('#view button:has-text("Set up milestones")');
  await page.click('.sheet button:has-text("Save milestones")');
  await page.waitForSelector('text=Run supabase/schema.sql');
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
  await page.waitForSelector('text=This also deletes their 2 projects and 3 money entries');
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
    for (const hash of ['#/', '#/projects', '#/clients', '#/money', '#/project/' + ids.gbSite, '#/client/' + ids.edustudy]) {
      await page.goto(SITE + hash);
      await page.locator('#view h1').first().waitFor();
      const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
      assert.ok(scroll <= width, hash + ' scrolls sideways on a phone (' + scroll + 'px > ' + width + 'px)');
    }
    await page.click('#view button:has-text("+ Add money")');
    const box = await page.locator('.sheet').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 375, 'the add-money sheet is wider than the phone');
    await page.keyboard.press('Escape');
    await page.goto(SITE + '#/project/' + ids.gbSite);
    await page.click('#view button:has-text("Edit milestones")');
    const ms = await page.locator('.sheet').boundingBox();
    assert.ok(ms.x >= 0 && ms.x + ms.width <= 375, 'the milestones sheet is wider than the phone');
    assert.ok(await page.locator('.sheet').evaluate(el => el.scrollWidth <= el.clientWidth), 'the milestones sheet scrolls sideways');
  });
}
