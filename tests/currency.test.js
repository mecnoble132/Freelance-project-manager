// Currencies, financial years and time zones on the MCP side (tester launch plan, step 2).
// The owner's own case (rupees, April, India time) is covered by the older tests, which are unchanged; these cover everything else.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers/setup');
const { ids, seedUsd, OWNER, OTHER } = require('./helpers/seed');
const { TOOLS } = require('../api/_lib/tools');
const { Invalid } = require('../api/_lib/writes');
const L = require('../api/_lib/ledger');

const call = (db, name, args = {}) => TOOLS.find(x => x.name === name).run(db, args);
const theirs = store => JSON.stringify(Object.values(store.rows).flat().filter(r => r.user_id === OTHER));

// Same helper as writes.test.js: run a change, check it, undo it, and check every table is exactly as before.
async function changeAndUndo(ctx, name, args, check) {
  const before = ctx.store.snapshot(), other = theirs(ctx.store);
  const r = await call(ctx.db, name, args);
  assert.equal(r.done, true, JSON.stringify(r));
  if (check) await check(r);
  assert.notDeepEqual(ctx.store.snapshot(), before, name + ' changed nothing');
  const u = await call(ctx.db, 'undo_change', { change_id: r.change_id });
  assert.equal(u.done, true, JSON.stringify(u));
  assert.deepEqual(ctx.store.snapshot(), before, 'undo of ' + name + ' left the data different');
  assert.equal(theirs(ctx.store), other);
  return r;
}
// A ledger with rupee and dollar money, and the settings row changed as given.
function usdSetup(t, settings) {
  const ctx = setup(t);
  seedUsd(ctx.store);
  if (settings) ctx.store.update('settings', r => r.user_id === OWNER, settings);
  return ctx;
}
const setSettings = (ctx, patch) => ctx.store.update('settings', r => r.user_id === OWNER, patch);

// ---------- helpers ----------
test('money is written in its own currency and locale', () => {
  assert.equal(L.formatMoney(20000, 'INR', 'en-IN'), '₹20,000');
  assert.equal(L.formatMoney(1234567, 'INR', 'en-IN'), '₹12,34,567');
  assert.equal(L.formatMoney(1200.5, 'USD', 'en-US'), '$1,200.50');
  assert.equal(L.formatMoney(3000, 'JPY', 'en-US'), '¥3,000');
  assert.equal(L.formatMoney(99.999, 'JPY', 'en-US'), '¥100'); // yen has no decimals
  assert.match(L.formatMoney(5, 'GBP', 'en-GB'), /^£5$/);
});

test('the currency list is the one in schema.sql', () => {
  const { parse } = require('./helpers/schema');
  assert.deepEqual(L.CURRENCIES, parse().projects.checks.currency.values);
  assert.ok(TOOLS.find(x => x.name === 'create_project').inputSchema.properties.currency.enum.every(c => L.CURRENCIES.includes(c)));
});

test('financial years start in any month; January means the calendar year', () => {
  assert.deepEqual(L.fyRange(2026), { from: '2026-04-01', to: '2027-03-31', label: 'FY 2026–27' }); // the owner's, unchanged
  assert.deepEqual(L.fyRange(2026, 1), { from: '2026-01-01', to: '2026-12-31', label: 'FY 2026' });
  assert.deepEqual(L.fyRange(2026, 7), { from: '2026-07-01', to: '2027-06-30', label: 'FY 2026–27' });
  assert.deepEqual(L.fyRange(2026, 2), { from: '2026-02-01', to: '2027-01-31', label: 'FY 2026–27' });
  assert.deepEqual(L.fyRange(2026, 10), { from: '2026-10-01', to: '2027-09-30', label: 'FY 2026–27' });
  assert.equal(L.fyStartYear('2026-03-31', 4), 2025);
  assert.equal(L.fyStartYear('2026-04-01', 4), 2026);
  assert.equal(L.fyStartYear('2026-12-31', 1), 2026);
  assert.equal(L.fyStartYear('2027-01-01', 7), 2026);
  assert.equal(L.fyOf('2026-10-23'), '2026-27');
  assert.equal(L.fyOf('2026-10-23', 1), '2026');
  assert.equal(L.fyOf('2027-01-05', 10), '2026-27');
});

test('invoice numbers follow the financial year start month', () => {
  const used = ['INV/2026-27/001', 'INV/2026/004'];
  assert.equal(L.nextInvoiceNumber(used, 'INV', '2026-10-23'), 'INV/2026-27/002'); // April start, as before
  assert.equal(L.nextInvoiceNumber(used, 'INV', '2026-10-23', 1), 'INV/2026/005');
  assert.equal(L.nextInvoiceNumber(used, 'INV', '2027-01-01', 1), 'INV/2027/001');
  assert.equal(L.nextInvoiceNumber(used, 'INV', '2026-12-31', 1), 'INV/2026/005');
  assert.equal(L.nextInvoiceNumber([], 'INV', '2026-07-01', 7), 'INV/2026-27/001');
  assert.equal(L.nextInvoiceNumber([], 'INV', '2026-06-30', 7), 'INV/2025-26/001');
});

test('today comes from the time zone, including where the date differs from UTC', t => {
  setup(t);
  t.mock.timers.setTime(Date.parse('2026-10-24T02:00:00Z'));
  assert.equal(L.todayIn('UTC'), '2026-10-24');
  assert.equal(L.todayIn('America/New_York'), '2026-10-23'); // 22:00 the evening before
  assert.equal(L.todayIn('Asia/Kolkata'), '2026-10-24');
  assert.equal(L.todayIn('Pacific/Auckland'), '2026-10-24'); // 15:00
  t.mock.timers.setTime(Date.parse('2026-10-23T12:00:00Z'));
  assert.equal(L.todayIn('Pacific/Auckland'), '2026-10-24'); // already 01:00 tomorrow
  assert.equal(L.todayIn('America/Los_Angeles'), '2026-10-23');
  assert.equal(L.todayIn('Not/AZone'), L.todayIn('Asia/Kolkata'), 'a bad time zone falls back to the old default instead of crashing');
  assert.equal(L.todayIn(undefined), L.todayIn('Asia/Kolkata'));
  // Daylight saving: New York is UTC-4 until 1 Nov 2026, UTC-5 after.
  t.mock.timers.setTime(Date.parse('2026-11-01T04:30:00Z'));
  assert.equal(L.todayIn('America/New_York'), '2026-11-01'); // 00:30 EDT
  t.mock.timers.setTime(Date.parse('2026-11-02T04:30:00Z'));
  assert.equal(L.todayIn('America/New_York'), '2026-11-01'); // 23:30 EST the day before
});

// ---------- totals are per currency ----------
test('the summary reports one currency and lists the others, never adding them', async t => {
  const { db } = usdSetup(t);
  const s = (await L.load(db)).summary();
  assert.equal(s.currency, 'INR');
  assert.deepEqual([s.revenue, s.spending, s.profit, s.stillToCollect], [40000, 1500, 38500, 30000]); // exactly the rupee figures, as before
  assert.deepEqual(s.otherCurrencies, [{ currency: 'USD', revenue: 1000, spending: 120, profit: 880, stillToCollect: 2000 }]);
  assert.match(s.otherCurrenciesNote, /only for INR/);
  const usd = (await L.load(db)).summary({ currency: 'USD' });
  assert.equal(usd.currency, 'USD');
  assert.deepEqual([usd.revenue, usd.spending, usd.profit, usd.stillToCollect, usd.marginPercent], [1000, 120, 880, 2000, 88]);
  assert.deepEqual(usd.otherCurrencies.map(o => [o.currency, o.revenue]), [['INR', 40000]]);
  assert.deepEqual(usd.byMonth, [{ month: '2026-10', revenue: 1000, spending: 120, profit: 880 }]);
  assert.deepEqual(usd.spendingByCategory, { 'Software & plugins': 120 });
  assert.deepEqual(usd.projectsByProfit.map(p => p.project), ['Brand site']);
  assert.deepEqual(usd.stillToCollectByProject.map(p => [p.project, p.currency, p.stillToCollect]), [['Brand site', 'USD', 2000]]);
  assert.equal(usd.invoices.unpaid, 0); // the USD invoice is paid by its advance
  assert.equal(usd.pipelineFromLeads, 0); // the 80,000 rupee lead isn't a dollar lead
  assert.equal((await L.load(db)).summary({ currency: 'INR' }).revenue, 40000);
  assert.match((await L.load(db).then(l => l.summary({ currency: 'XXX' }))).error, /currency must be one of/);
  assert.equal((await L.load(db)).summary({ currency: 'usd' }).currency, 'USD', 'lower case is fine');
});

test('the default currency decides what is reported when none is asked for', async t => {
  const { db } = usdSetup(t, { default_currency: 'USD' });
  const s = (await L.load(db)).summary();
  assert.deepEqual([s.currency, s.revenue, s.otherCurrencies[0].currency], ['USD', 1000, 'INR']);
});

test('a ledger with one currency looks as before, plus the currency field', async t => {
  const { db } = setup(t);
  const l = await L.load(db);
  const s = l.summary();
  assert.equal(s.currency, 'INR');
  assert.equal(s.otherCurrencies, undefined);
  assert.equal(s.otherCurrenciesNote, undefined);
  assert.equal(l.listClients().currency, 'INR');
  assert.equal(l.attention().currency, 'INR');
  assert.equal(l.attention().currencies, undefined);
});

test('a user with only dollar money gets dollars without asking, even if their default says rupees', async t => {
  const ctx = setup(t, { empty: true });
  ctx.store.insert('clients', { id: ids.usdClient, name: 'Brightwave' }, OWNER);
  ctx.store.insert('projects', { id: ids.usdProject, client_id: ids.usdClient, name: 'Brand site', quoted: 3000, currency: 'USD' }, OWNER);
  ctx.store.insert('txns', { client_id: ids.usdClient, project_id: ids.usdProject, type: 'in', amount: 1000, currency: 'USD', date: '2026-10-03' }, OWNER);
  const s = (await L.load(ctx.db)).summary();
  assert.deepEqual([s.currency, s.revenue, s.otherCurrencies], ['USD', 1000, undefined]);
});

test('compare_periods, clients, transactions, invoices, overdue and renewals are per currency too', async t => {
  const { db } = usdSetup(t);
  const l = await L.load(db);
  const cmp = l.comparePeriods({ preset: 'month_vs_last_month' });
  assert.equal(cmp.currency, 'INR');
  assert.equal(cmp.current.revenue, 20000);
  assert.equal(l.comparePeriods({ currency: 'USD' }).current.revenue, 1000);
  assert.deepEqual(cmp.otherCurrencies.map(o => o.currency), ['USD']);

  const clients = l.listClients();
  assert.equal(clients.currency, 'INR');
  assert.deepEqual(clients.clients.find(c => c.name === 'Brightwave').revenue, 0, 'dollar money is not in the rupee column');
  assert.equal(l.listClients({ currency: 'USD' }).clients.find(c => c.name === 'Brightwave').revenue, 1000);

  const tx = l.listTransactions({ period: 'this_month' });
  assert.deepEqual([tx.currency, tx.revenue, tx.count], ['INR', 20000, 2]);
  assert.deepEqual(l.listTransactions({ period: 'this_month', currency: 'USD' }).transactions.map(x => [x.amount, x.currency]), [[120, 'USD'], [1000, 'USD']]);

  const inv = l.listInvoices({ filter: 'all' });
  assert.ok(inv.invoices.every(i => i.currency === 'INR'));
  assert.deepEqual(l.listInvoices({ filter: 'all', currency: 'USD' }).invoices.map(i => [i.number, i.currency, i.total, i.state]), [['INV/2026-27/004', 'USD', 1000, 'paid']]);

  assert.equal(l.listOverdue().totalOverdue, 15000);
  assert.equal(l.listOverdue({ currency: 'USD' }).totalOverdue, 0);

  const ren = l.listRenewals();
  assert.deepEqual([ren.currency, ren.yearly], ['INR', { revenue: 31500, cost: 3800, profit: 27700 }]);
  const renUsd = l.listRenewals({ currency: 'USD' });
  assert.deepEqual([renUsd.yearly, renUsd.services.map(s => [s.name, s.currency])], [{ revenue: 20, cost: 12, profit: 8 }, [['brightwave.com', 'USD']]]);
});

test('a project, client or invoice filter picks its own currency when none is given', async t => {
  const { db } = usdSetup(t);
  const l = await L.load(db);
  const byProject = l.listTransactions({ project: 'Brand site' });
  assert.deepEqual([byProject.currency, byProject.revenue, byProject.count, byProject.otherCurrencies.map(o => o.currency)], ['USD', 1000, 2, ['INR']]);
  assert.equal(l.listTransactions({ client: 'Brightwave' }).currency, 'USD');
  assert.equal(l.listTransactions({ client: 'GeekBoz' }).currency, 'INR');
  assert.equal(l.listInvoices({ client: 'Brightwave', filter: 'all' }).invoices.length, 1);
  const c = l.getClient({ client: 'Brightwave' });
  assert.deepEqual([c.currency, c.revenue, c.projects.map(p => p.currency), c.services.map(s => s.currency)], ['USD', 1000, ['USD'], ['USD']]);
  assert.equal(l.getClient({ client: 'GeekBoz' }).currency, 'INR');
  assert.equal(l.getClient({ client: 'GeekBoz' }).revenue, 20000);
});

test('attention items, project lists and searches say each item\'s currency', async t => {
  const { db } = usdSetup(t);
  const l = await L.load(db);
  const a = l.attention();
  assert.deepEqual(a.currencies, ['INR', 'USD']);
  assert.equal(a.currency, undefined);
  assert.deepEqual(a.stillToCollect.map(x => [x.project, x.currency]).sort(), [['Brand site', 'USD'], ['Website', 'INR']]);
  assert.ok(a.overdueMilestones.every(m => m.currency === 'INR'));
  assert.deepEqual(a.renewalsDue.map(x => x.currency).sort(), ['INR', 'INR']); // the dollar domain renews in February
  const ps = l.listProjects();
  assert.deepEqual(ps.currencies, ['INR', 'USD']);
  assert.deepEqual(ps.projects.map(p => [p.title, p.currency]).sort(), [['App', 'INR'], ['Brand site', 'USD'], ['Website', 'INR'], ['Website', 'INR']]);
  const bs = l.getProject({ project: 'Brand site' });
  assert.deepEqual([bs.currency, bs.money.quoted, bs.money.received, bs.money.stillToCollect, bs.transactions.map(x => x.currency)], ['USD', 3000, 1000, 2000, ['USD', 'USD']]);
  assert.equal(l.search({ query: 'fonts' }).transactions[0].currency, 'USD');
  const inv = l.getInvoice({ invoice: 'INV/2026-27/004' });
  assert.deepEqual([inv.currency, inv.total, inv.upiLink, inv.payTo.upiId], ['USD', 1000, undefined, null]);
  assert.match(l.getInvoice({ invoice: '002' }).upiLink, /^upi:\/\/pay\?.*cu=INR/, 'rupee invoices still have their UPI link');
});

test('a reminder for a dollar invoice is in dollars, with no UPI link', async t => {
  const { db, store } = usdSetup(t);
  store.update('invoices', r => r.id === ids.usdInvoice, { status: 'sent', due_date: '2026-10-10' });
  store.update('txns', r => r.id === ids.usdAdvance, { invoice_id: null }); // unpaid
  const l = await L.load(db);
  const f = l.reminderFacts({ invoice: 'INV/2026-27/004' });
  assert.deepEqual([f.currency, f.totalDue, f.invoices[0].upiLink, f.payTo.upiId, f.tone], ['USD', 1000, undefined, null, 'firm']); // 13 days overdue
  const byClient = l.reminderFacts({ client: 'Brightwave' });
  assert.deepEqual([byClient.currency, byClient.totalDue], ['USD', 1000]);
  assert.equal(l.reminderFacts({ client: 'GeekBoz' }).currency, 'INR');
  const lo = l.listOverdue({ currency: 'USD' });
  assert.deepEqual([lo.currency, lo.totalOverdue, lo.clients.map(c => c.client)], ['USD', 1000, ['Brightwave']]);
  assert.deepEqual(lo.otherCurrencies.map(o => o.currency), ['INR']);
});

test('the other user\'s dollar money never shows up', async t => {
  const { db } = usdSetup(t);
  const l = await L.load(db);
  for (const c of ['INR', 'USD']) assert.ok(JSON.stringify(l.summary({ currency: c })).indexOf('77777') < 0 && JSON.stringify(l.summary({ currency: c })).indexOf('99999') < 0);
  assert.equal(l.summary({ currency: 'USD' }).revenue, 1000);
});

// ---------- the currency invariants ----------
test('new projects take the default currency or the one given, and undo removes them', async t => {
  const ctx = setup(t);
  await changeAndUndo(ctx, 'create_project', { title: 'Shop', client: 'GeekBoz', quoted: 5000 }, r => {
    const p = ctx.store.rows.projects.find(x => x.name === 'Shop');
    assert.equal(p.currency, 'INR');
  });
  const r = await changeAndUndo(ctx, 'create_project', { title: 'Shop', client: 'GeekBoz', quoted: 5000, currency: 'eur' }, () => {
    assert.equal(ctx.store.rows.projects.find(x => x.name === 'Shop').currency, 'EUR');
  });
  assert.equal(r.project.title, 'Shop');
  setSettings(ctx, { default_currency: 'GBP' });
  await changeAndUndo(ctx, 'create_project', { title: 'Shop', client: 'GeekBoz' }, () => assert.equal(ctx.store.rows.projects.find(x => x.name === 'Shop').currency, 'GBP'));
  await assert.rejects(call(ctx.db, 'create_project', { title: 'Shop', client: 'GeekBoz', currency: 'XYZ' }), Invalid);
  await assert.rejects(call(ctx.db, 'create_project', { title: 'Shop', client: 'GeekBoz', currency: 'XYZ' }), /Currency must be one of: INR, USD/);
  assert.equal(ctx.store.rows.projects.length, 4); // nothing was added
});

test('money takes the currency of its project; without one it takes the default or the one given', async t => {
  const ctx = usdSetup(t);
  await changeAndUndo(ctx, 'add_payment', { amount: 500, project: 'Brand site' }, r => {
    assert.equal(ctx.store.rows.txns.find(x => x.id === r.entries[0].id).currency, 'USD');
    assert.match(r.message, /^Saved \$500 in\.$/);
    assert.equal(r.entries[0].currency, 'USD');
  });
  await changeAndUndo(ctx, 'add_expense', { amount: 50, project: 'Brand site', note: 'Fonts', category: 'Design assets' }, r => assert.match(r.message, /\$50 out/));
  await changeAndUndo(ctx, 'add_payment', { amount: 700, client: 'Brightwave' }, r => assert.equal(ctx.store.rows.txns.find(x => x.id === r.entries[0].id).currency, 'INR')); // default, no project
  await changeAndUndo(ctx, 'add_payment', { amount: 700, client: 'Brightwave', currency: 'GBP' }, r => {
    assert.equal(ctx.store.rows.txns.find(x => x.id === r.entries[0].id).currency, 'GBP');
    assert.match(r.message, /£700 in/);
  });
  await changeAndUndo(ctx, 'add_payment', { amount: 1000, invoice: '002' }, r => assert.equal(ctx.store.rows.txns.find(x => x.id === r.entries[0].id).currency, 'INR'));
  // several at once, in different currencies: written side by side, not added
  await changeAndUndo(ctx, 'add_transactions', { entries: [{ type: 'in', amount: 100, project: 'Brand site' }, { type: 'in', amount: 200, project: 'GeekBoz Website' }, { type: 'out', amount: 5, project: 'Brand site' }] },
    r => assert.equal(r.message, 'Saved 3 entries: $100 in, $5 out, ₹200 in.'));
});

test('money in another currency than its project or invoice is refused', async t => {
  const ctx = usdSetup(t);
  const before = ctx.store.snapshot();
  const refuse = async (name, args, re) => { await assert.rejects(call(ctx.db, name, args), re); assert.deepEqual(ctx.store.snapshot(), before, 'nothing may be saved'); };
  await refuse('add_payment', { amount: 500, project: 'Brand site', currency: 'INR' }, /That project is in USD; this payment is in INR/);
  await refuse('add_expense', { amount: 500, project: 'GeekBoz Website', currency: 'USD' }, /That project is in INR; this expense is in USD/);
  await refuse('add_payment', { amount: 500, invoice: '004', currency: 'INR' }, /INV\/2026-27\/004 is in USD; this payment is in INR/);
  await refuse('add_transactions', { entries: [{ type: 'in', amount: 1, project: 'Brand site' }, { type: 'in', amount: 1, project: 'Brand site', currency: 'EUR' }] }, /Entry 2: That project is in USD/);
  await refuse('add_payment', { amount: 5, client: 'Brightwave', currency: 'ABC' }, /must be one of/);
  // the same currency written out is fine
  const ok = await call(ctx.db, 'add_payment', { amount: 5, project: 'Brand site', currency: 'USD' });
  assert.equal(ok.done, true);
});

test('editing money keeps it in its project\'s and invoice\'s currency', async t => {
  const ctx = usdSetup(t);
  const before = ctx.store.snapshot();
  const refuse = async (args, re) => { await assert.rejects(call(ctx.db, 'update_transaction', args), re); assert.deepEqual(ctx.store.snapshot(), before); };
  await refuse({ id: ids.advance, project: 'Brand site' }, /That project is in USD; this payment is in INR/); // moving a rupee payment to a dollar project
  await refuse({ id: ids.usdAdvance, project: 'GeekBoz Website' }, /That project is in INR; this payment is in USD/);
  await refuse({ id: ids.usdFonts, currency: 'INR' }, /That project is in USD; this expense is in INR/);
  await refuse({ id: ids.advance, invoice: 'INV/2026-27/004' }, /is in USD; this payment is in INR/);
  // detaching from the project frees the currency, and the currency is kept
  await changeAndUndo(ctx, 'update_transaction', { id: ids.usdFonts, project: '', client: 'Brightwave' }, () => {
    const t = ctx.store.rows.txns.find(x => x.id === ids.usdFonts);
    assert.deepEqual([t.project_id, t.currency], [null, 'USD']);
  });
  await changeAndUndo(ctx, 'update_transaction', { id: ids.hosting, currency: 'EUR' }, () => assert.equal(ctx.store.rows.txns.find(x => x.id === ids.hosting).currency, 'EUR')); // no project, so it may change
  await changeAndUndo(ctx, 'update_transaction', { id: ids.advance, amount: 21000 }, () => assert.equal(ctx.store.rows.txns.find(x => x.id === ids.advance).currency, 'INR'));
});

test('a project\'s currency can only change while nothing is attached to it', async t => {
  const ctx = usdSetup(t);
  const before = ctx.store.snapshot();
  await assert.rejects(call(ctx.db, 'update_project', { project: 'Brand site', currency: 'EUR' }), /"Brand site" is in USD and already has 2 payments or expenses, 1 invoices, 1 renewals, so its currency can't change/);
  await assert.rejects(call(ctx.db, 'update_project', { project: 'Website', client: 'Edustudy', currency: 'USD' }), /already has/);
  assert.deepEqual(ctx.store.snapshot(), before);
  // the same currency is not a change
  await assert.rejects(call(ctx.db, 'update_project', { project: 'Brand site', currency: 'USD' }), /Say what to change/);
  const ok = await call(ctx.db, 'update_project', { project: 'Brand site', currency: 'USD', quoted: 3500 });
  assert.equal(ok.done, true); assert.deepEqual(Object.keys(ctx.store.rows.activity_log.at(-1).after), ['quoted']);
  await call(ctx.db, 'undo_change', {});
  // an empty project may change currency, and undo changes it back
  await call(ctx.db, 'create_project', { title: 'Blank', client: 'Brightwave', currency: 'USD' });
  await changeAndUndo(ctx, 'update_project', { project: 'Blank', currency: 'EUR' }, r => {
    assert.equal(ctx.store.rows.projects.find(x => x.name === 'Blank').currency, 'EUR');
    assert.equal(r.project.currency, 'EUR');
  });
  // milestones count too
  await call(ctx.db, 'set_milestones', { project: 'Blank', milestones: [{ amount: 10 }] });
  await assert.rejects(call(ctx.db, 'update_project', { project: 'Blank', currency: 'GBP' }), /1 milestones/);
  // and so does a task? no: tasks don't carry money, so a project with only tasks is still free to change
  await call(ctx.db, 'set_milestones', { project: 'Blank', milestones: [] });
  await call(ctx.db, 'add_task', { project: 'Blank', tasks: ['x'] });
  assert.equal((await call(ctx.db, 'update_project', { project: 'Blank', currency: 'GBP' })).done, true);
});

test('invoices are in their project\'s currency, numbered by the financial year, without a UPI link for dollars', async t => {
  const ctx = usdSetup(t);
  await changeAndUndo(ctx, 'create_invoice', { project: 'Brand site', items: [{ description: 'Pages', quantity: 2, rate: 450.5 }] }, r => {
    assert.equal(r.invoice.currency, 'USD');
    assert.equal(r.invoice.number, 'INV/2026-27/005'); // numbers count up across currencies
    assert.match(r.message, /\$901/);
    assert.equal(r.invoice.upiLink, undefined);
    assert.equal(r.invoice.payTo.upiId, null);
    assert.equal(ctx.store.rows.invoices.find(x => x.number === 'INV/2026-27/005').currency, 'USD');
    assert.match(r.setupNeeded || '', /^$|bank details/);
  });
  await changeAndUndo(ctx, 'create_invoice', { client: 'Brightwave', items: [{ description: 'Hosting', rate: 40 }], currency: 'EUR' }, r => assert.equal(r.invoice.currency, 'EUR'));
  await changeAndUndo(ctx, 'create_invoice', { client: 'Brightwave', items: [{ description: 'Hosting', rate: 40 }] }, r => assert.equal(r.invoice.currency, 'INR')); // no project: the default
  await changeAndUndo(ctx, 'create_invoice', { project: 'GeekBoz Website', items: [{ description: 'More', rate: 1000 }] }, r => { assert.equal(r.invoice.currency, 'INR'); assert.match(r.invoice.upiLink, /^upi:/); });
  await assert.rejects(call(ctx.db, 'create_invoice', { project: 'Brand site', currency: 'INR', items: [{ description: 'x', rate: 1 }] }), /Brand site.*is in USD, so its invoices are too/);
  // a milestone invoice is in the project's currency
  await call(ctx.db, 'set_milestones', { project: 'Brand site', split: [50, 50] });
  await changeAndUndo(ctx, 'create_invoice', { project: 'Brand site', milestone: 'Final payment' }, r => assert.deepEqual([r.invoice.currency, r.invoice.total], ['USD', 1500]));
  // updating an invoice keeps its currency
  await changeAndUndo(ctx, 'update_invoice', { invoice: '004', status: 'cancelled' }, () => assert.equal(ctx.store.rows.invoices.find(x => x.id === ids.usdInvoice).currency, 'USD'));
  await assert.rejects(call(ctx.db, 'update_invoice', { invoice: '004', items: [{ description: 'x', rate: 0.001 }] }), /above \$0/);
});

test('a payment for a dollar invoice settles it, and the project\'s milestones use its currency', async t => {
  const ctx = usdSetup(t);
  ctx.store.update('txns', r => r.id === ids.usdAdvance, { invoice_id: null });
  const pay = await call(ctx.db, 'add_payment', { amount: 1000, invoice: '004' });
  assert.equal(pay.done, true);
  assert.equal(ctx.store.rows.txns.find(x => x.id === pay.entries[0].id).currency, 'USD');
  assert.equal((await L.load(ctx.db)).getInvoice({ invoice: '004' }).state, 'paid');
  const m = await call(ctx.db, 'set_milestones', { project: 'Brand site', split: [50, 30, 20] });
  assert.match(m.message, /totalling \$3,000\./);
  assert.deepEqual(m.milestones.map(x => x.amount), [1500, 900, 600]);
  const off = await call(ctx.db, 'set_milestones', { project: 'Brand site', milestones: [{ amount: 100 }, { amount: 100 }] });
  assert.match(off.warning, /add up to \$200, but the quote is \$3,000/);
});

test('renewals are in their project\'s currency, and renewing logs and invoices in it', async t => {
  const ctx = usdSetup(t);
  await changeAndUndo(ctx, 'add_service', { client: 'Brightwave', project: 'Brand site', name: 'Hosting', kind: 'hosting', cost: 10, price: 25, next_renewal: '2026-12-01' }, r => {
    assert.equal(r.service.currency, 'USD');
    assert.equal(ctx.store.rows.services.find(x => x.name === 'Hosting').currency, 'USD');
  });
  await changeAndUndo(ctx, 'add_service', { client: 'GeekBoz', name: 'Email', price: 10, next_renewal: '2026-12-01', currency: 'AUD' }, r => assert.equal(r.service.currency, 'AUD'));
  await changeAndUndo(ctx, 'add_service', { client: 'GeekBoz', name: 'Email', price: 10, next_renewal: '2026-12-01' }, r => assert.equal(r.service.currency, 'INR'));
  await assert.rejects(call(ctx.db, 'add_service', { client: 'Brightwave', project: 'Brand site', name: 'x', next_renewal: '2026-12-01', currency: 'INR' }), /is in USD, so its renewals are too/);
  // editing: the project and the service must agree
  await call(ctx.db, 'create_project', { title: 'Dollar site', client: 'GeekBoz', currency: 'USD' });
  await assert.rejects(call(ctx.db, 'update_service', { service: 'geekboz.in', project: 'Dollar site' }), /Dollar site.*is in USD but this service is in INR/);
  await call(ctx.db, 'undo_change', {});
  await assert.rejects(call(ctx.db, 'update_service', { service: 'brightwave.com', currency: 'INR' }), /is in USD but this service is in INR/);
  await changeAndUndo(ctx, 'update_service', { service: 'brightwave.com', project: '', currency: 'EUR' }, () => assert.equal(ctx.store.rows.services.find(x => x.id === ids.usdService).currency, 'EUR'));
  // renewing the dollar domain: a dollar expense and a dollar draft invoice
  const preview = await call(ctx.db, 'renew_service', { service: 'brightwave.com' });
  assert.deepEqual(preview.steps, ['Log $12 spent on brightwave.com (Domain).', 'Create draft invoice INV/2026-27/005 to Brightwave for $20.', 'Move the next renewal from 1 Feb 2027 to 1 Feb 2028.']);
  await changeAndUndo(ctx, 'renew_service', { service: 'brightwave.com', confirm: true }, () => {
    const exp = ctx.store.rows.txns.find(x => x.note === 'brightwave.com renewal'), inv = ctx.store.rows.invoices.find(x => x.number === 'INV/2026-27/005');
    assert.deepEqual([exp.currency, exp.amount, exp.project_id], ['USD', 12, ids.usdProject]);
    assert.deepEqual([inv.currency, inv.total], ['USD', 20]);
  });
});

test('deleting a project leaves its money, invoices and renewals in their own currency', async t => {
  const ctx = usdSetup(t);
  const preview = await call(ctx.db, 'delete_project', { project: 'Brand site' });
  assert.equal(preview.confirmation_required, true);
  await changeAndUndo(ctx, 'delete_project', { project: 'Brand site', confirm: true }, () => {
    const left = ctx.store.rows.txns.filter(x => x.client_id === ids.usdClient);
    assert.deepEqual(left.map(x => [x.project_id, x.currency]), [[null, 'USD'], [null, 'USD']]);
    assert.equal(ctx.store.rows.invoices.find(x => x.id === ids.usdInvoice).currency, 'USD');
    assert.equal(ctx.store.rows.services.find(x => x.id === ids.usdService).currency, 'USD');
  });
  // after deleting it for real, the dollars are still dollars in every report
  await call(ctx.db, 'delete_project', { project: 'Brand site', confirm: true });
  const s = (await L.load(ctx.db)).summary({ currency: 'USD' });
  assert.deepEqual([s.revenue, s.spending], [1000, 120]);
  assert.equal((await L.load(ctx.db)).summary().revenue, 40000, 'and they didn\'t turn into rupees');
});

test('deleting a client shows money per currency', async t => {
  const ctx = usdSetup(t);
  const one = await call(ctx.db, 'delete_client', { client: 'Brightwave' });
  assert.deepEqual([one.moneyIn, one.moneyOut, one.currency], [1000, 120, 'USD']);
  ctx.store.insert('txns', { client_id: ids.usdClient, type: 'in', amount: 300, currency: 'INR', date: '2026-10-01' }, OWNER);
  const two = await call(ctx.db, 'delete_client', { client: 'Brightwave' });
  assert.deepEqual([two.moneyIn, two.moneyOut, two.currency], [{ USD: 1000, INR: 300 }, { USD: 120, INR: 0 }, undefined]);
  await changeAndUndo(ctx, 'delete_client', { client: 'Brightwave', confirm: true });
});

// ---------- financial year and time zone in the tools ----------
test('a January financial year changes the periods, labels and invoice numbers', async t => {
  const ctx = setup(t);
  const apr = (await L.load(ctx.db)).summary({ period: 'this_fy' });
  assert.deepEqual([apr.period, apr.from, apr.to, apr.revenue], ['FY 2026–27', '2026-04-01', '2027-03-31', 20000]); // the owner, unchanged
  setSettings(ctx, { fy_start_month: 1 });
  const jan = (await L.load(ctx.db)).summary({ period: 'this_fy' });
  assert.deepEqual([jan.period, jan.from, jan.to, jan.revenue], ['FY 2026', '2026-01-01', '2026-12-31', 35000]); // March's 15,000 is now in this year
  const last = (await L.load(ctx.db)).summary({ period: 'last_fy' });
  assert.deepEqual([last.period, last.from, last.to, last.revenue], ['FY 2025', '2025-01-01', '2025-12-31', 0]);
  const cmp = (await L.load(ctx.db)).comparePeriods({ preset: 'fy_vs_last_fy' });
  assert.deepEqual([cmp.current.period, cmp.previous.period], ['FY 2026', 'FY 2025']);
  await changeAndUndo(ctx, 'create_invoice', { client: 'Edustudy', items: [{ description: 'x', rate: 100 }] }, r => assert.equal(r.invoice.number, 'INV/2026/001'));
  await changeAndUndo(ctx, 'create_invoice', { client: 'Edustudy', items: [{ description: 'x', rate: 100 }], issue_date: '2027-01-01' }, r => assert.equal(r.invoice.number, 'INV/2027/001'));
  // "002" means this year's, whichever way the year is counted
  ctx.store.insert('invoices', { client_id: ids.edustudy, number: 'INV/2026/002', issue_date: '2026-06-01', items: [], total: 1, status: 'sent' }, OWNER);
  const found = (await L.load(ctx.db)).resolveInvoice('002');
  assert.equal(found.invoice && found.invoice.number, 'INV/2026/002');
  // the 31 December / 1 January boundary
  t.mock.timers.setTime(Date.parse('2026-12-31T20:00:00Z')); // 01:30 on 1 Jan in India
  assert.equal((await L.load(ctx.db)).summary({ period: 'this_fy' }).period, 'FY 2027');
  assert.equal((await L.load(ctx.db)).summary({ period: 'last_fy' }).period, 'FY 2026');
});

test('a July financial year runs July to June', async t => {
  const ctx = setup(t);
  setSettings(ctx, { fy_start_month: 7 });
  const s = (await L.load(ctx.db)).summary({ period: 'this_fy' });
  assert.deepEqual([s.period, s.from, s.to], ['FY 2026–27', '2026-07-01', '2027-06-30']);
  assert.equal((await L.load(ctx.db)).summary({ period: 'last_fy' }).from, '2025-07-01');
  await changeAndUndo(ctx, 'create_invoice', { client: 'Edustudy', items: [{ description: 'x', rate: 100 }], issue_date: '2026-06-30' }, r => assert.equal(r.invoice.number, 'INV/2025-26/003'));
});

test('"today" is the user\'s today: default dates, overdue checks and renewals follow their time zone', async t => {
  const ctx = setup(t);
  setSettings(ctx, { timezone: 'America/New_York', default_currency: 'USD', locale: 'en-US', fy_start_month: 1 });
  t.mock.timers.setTime(Date.parse('2026-10-24T02:00:00Z')); // 22:00 on the 23rd in New York, already the 24th in UTC and India
  const l = await L.load(ctx.db);
  assert.equal(l.today(), '2026-10-23');
  assert.equal(l.attention().today, '2026-10-23');
  assert.equal(l.listOverdue().today, '2026-10-23');
  assert.equal(l.listTasks().today, '2026-10-23');
  // nothing is overdue yet for something due on the 23rd; in India it would be
  ctx.store.update('invoices', r => r.id === ids.invDraft, { status: 'sent', due_date: '2026-10-23' });
  assert.equal((await L.load(ctx.db)).invoiceSummary((await L.load(ctx.db)).invoices.find(i => i.id === ids.invDraft)).state, 'unpaid');
  setSettings(ctx, { timezone: 'Asia/Kolkata' });
  assert.equal((await L.load(ctx.db)).invoiceSummary((await L.load(ctx.db)).invoices.find(i => i.id === ids.invDraft)).state, 'overdue');
  setSettings(ctx, { timezone: 'America/New_York' });
  // defaults for new entries
  const pay = await call(ctx.db, 'add_payment', { amount: 10, client: 'Edustudy' });
  assert.equal(ctx.store.rows.txns.find(x => x.id === pay.entries[0].id).date, '2026-10-23');
  const time = await call(ctx.db, 'log_time', { project: 'GeekBoz Website', minutes: 30 });
  assert.equal(time.entry.date, '2026-10-23');
  const inv = await call(ctx.db, 'create_invoice', { client: 'Edustudy', items: [{ description: 'x', rate: 100 }] });
  assert.deepEqual([inv.invoice.issueDate, inv.invoice.dueDate, inv.invoice.number], ['2026-10-23', '2026-10-30', 'INV/2026/001']);
  const rem = await call(ctx.db, 'log_reminder', { invoice: 'INV/2026-27/002' });
  assert.equal(rem.done, true);
  assert.equal(ctx.store.rows.invoices.find(x => x.id === ids.invDesign).last_reminded, '2026-10-23');
  // at the same instant in India it is the 24th
  setSettings(ctx, { timezone: 'Asia/Kolkata' });
  const pay2 = await call(ctx.db, 'add_payment', { amount: 10, client: 'Edustudy' });
  assert.equal(ctx.store.rows.txns.find(x => x.id === pay2.entries[0].id).date, '2026-10-24');
  // renewals: a service due on the 24th is still "in a day" in New York
  setSettings(ctx, { timezone: 'America/New_York' });
  ctx.store.update('services', r => r.id === ids.svcDomain, { next_renewal: '2026-10-24' });
  const s = (await L.load(ctx.db)).serviceSummary((await L.load(ctx.db)).services.find(x => x.id === ids.svcDomain));
  assert.deepEqual([s.daysUntilRenewal, s.overdue], [1, false]);
  const renewal = await call(ctx.db, 'renew_service', { service: 'geekboz.in', confirm: true });
  assert.equal(ctx.store.rows.txns.find(x => x.note === 'geekboz.in renewal').date, '2026-10-23');
  assert.equal(renewal.done, true);
});

test('milestone and project due dates are checked against the user\'s today', async t => {
  const ctx = setup(t);
  const l = await L.load(ctx.db);
  assert.equal(l.milestones(l.project(ids.gbSite)).find(m => m.name === 'Design').daysOverdue, 8);
  setSettings(ctx, { timezone: 'Pacific/Auckland' }); // 19:30 on 23 Oct
  t.mock.timers.setTime(Date.parse('2026-10-14T12:00:00Z')); // 01:00 on 15 Oct in Auckland; 17:30 on the 14th in India
  const auckland = await L.load(ctx.db);
  assert.equal(auckland.today(), '2026-10-15');
  assert.equal(auckland.milestones(auckland.project(ids.gbSite)).find(m => m.name === 'Design').state, 'unpaid', 'due today is not overdue');
  setSettings(ctx, { timezone: 'Asia/Kolkata' });
  assert.equal((await L.load(ctx.db)).today(), '2026-10-14');
});

// ---------- settings ----------
test('regional settings: shown, validated, saved and undone', async t => {
  const ctx = setup(t);
  const before = await call(ctx.db, 'get_settings');
  assert.deepEqual([before.settings.defaultCurrency, before.settings.fyStartMonth, before.settings.timezone, before.settings.locale], ['INR', 4, 'Asia/Kolkata', 'en-IN']);
  await changeAndUndo(ctx, 'update_settings', { default_currency: 'usd', fy_start_month: 1, timezone: 'America/New_York', locale: 'en-US' }, r => {
    assert.deepEqual([r.settings.defaultCurrency, r.settings.fyStartMonth, r.settings.timezone, r.settings.locale], ['USD', 1, 'America/New_York', 'en-US']);
    assert.match(r.note, /restart at 001/);
  });
  await changeAndUndo(ctx, 'update_settings', { timezone: 'Europe/London' }, r => assert.equal(r.note, undefined));
  const refuse = (args, re) => assert.rejects(call(ctx.db, 'update_settings', args), re);
  await refuse({ default_currency: 'BTC' }, /default currency must be one of/);
  await refuse({ fy_start_month: 13 }, /from 1 \(January\) to 12/);
  await refuse({ fy_start_month: 0 }, /from 1/);
  await refuse({ fy_start_month: 4.5 }, /whole number/);
  await refuse({ timezone: 'Mars/Olympus' }, /time zone isn't recognised/);
  await refuse({ timezone: '' }, /time zone isn't recognised/);
  await refuse({ locale: 'fr-FR' }, /locale must be one of/);
  await refuse({}, /default_currency, fy_start_month, timezone or locale/);
  assert.equal(ctx.store.rows.settings.filter(r => r.user_id === OWNER).length, 1);
  assert.equal(ctx.store.rows.settings.find(r => r.user_id === OTHER).default_currency, 'USD', 'the other user\'s settings are untouched');
});

test('a brand-new user can set regional settings before anything else, and gets the defaults until then', async t => {
  const ctx = setup(t, { empty: true });
  const fresh = await L.load(ctx.db);
  assert.deepEqual([fresh.settings.defaultCurrency, fresh.settings.fyStartMonth, fresh.settings.timezone, fresh.settings.locale], ['INR', 4, 'Asia/Kolkata', 'en-IN']);
  await changeAndUndo(ctx, 'update_settings', { default_currency: 'EUR', timezone: 'Europe/Berlin', locale: 'en-GB' }, () => {
    const row = ctx.store.rows.settings.find(r => r.user_id === OWNER);
    assert.deepEqual([row.default_currency, row.fy_start_month, row.timezone], ['EUR', 4, 'Europe/Berlin']);
  });
  await call(ctx.db, 'update_settings', { default_currency: 'EUR' });
  const created = await call(ctx.db, 'create_project', { title: 'Site', client: 'Acme', new_client: true });
  assert.equal(created.done, true);
  assert.equal(ctx.store.rows.projects[0].currency, 'EUR');
  // a settings row with nonsense in it (edited by hand) doesn't break anything
  ctx.store.rows.settings.find(r => r.user_id === OWNER).timezone = 'Nowhere/Land';
  assert.equal((await L.load(ctx.db)).settings.timezone, 'Asia/Kolkata');
});

test('every tool that totals money accepts a currency, and the descriptions no longer say rupees', () => {
  for (const n of ['get_summary', 'compare_periods', 'list_clients', 'get_client', 'list_transactions', 'list_invoices', 'list_overdue', 'draft_payment_reminder', 'log_reminder', 'list_renewals']) {
    assert.deepEqual(TOOLS.find(x => x.name === n).inputSchema.properties.currency.enum, L.CURRENCIES, n);
  }
  for (const n of ['create_project', 'update_project', 'add_payment', 'add_expense', 'update_transaction', 'create_invoice', 'add_service', 'update_service']) {
    assert.ok(TOOLS.find(x => x.name === n).inputSchema.properties.currency, n + ' should take a currency');
  }
  const text = JSON.stringify(TOOLS.map(({ run, ...t }) => t)) + require('../api/_lib/tools').INSTRUCTIONS;
  assert.doesNotMatch(text, /rupees|India time|Indian financial|April to March/i);
});
