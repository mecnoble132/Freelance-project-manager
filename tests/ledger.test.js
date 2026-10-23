// The numbers the MCP read tools report, worked out from the seed ledger (see tests/helpers/seed.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers/setup');
const { ids, OWNER } = require('./helpers/seed');
const { load, todayIST } = require('../api/_lib/ledger');

test('today is worked out in India time', t => {
  setup(t);
  assert.equal(todayIST(), '2026-10-23');
  t.mock.timers.setTime(Date.parse('2026-10-23T19:00:00Z')); // 00:30 on the 24th in India
  assert.equal(todayIST(), '2026-10-24');
});

test('summary for all time', async t => {
  const { db } = setup(t);
  const s = (await load(db)).summary();
  assert.equal(s.revenue, 40000);
  assert.equal(s.spending, 1500);
  assert.equal(s.profit, 38500);
  assert.equal(s.marginPercent, 96);
  assert.equal(s.stillToCollect, 30000);
  assert.equal(s.pipelineFromLeads, 80000);
  assert.equal(s.clients, 2);
  assert.deepEqual(s.projectsByStatus, { 'In progress': 1, Done: 1, Lead: 1 });
  assert.deepEqual(s.spendingByCategory, { Domain: 1000, Hosting: 500 });
  assert.equal(s.note, undefined);
});

test('summary per period; undated entries only count under all time', async t => {
  const { db } = setup(t);
  const L = await load(db);
  const month = L.summary({ period: 'this_month' });
  assert.deepEqual([month.revenue, month.spending, month.from], [20000, 1000, '2026-10-01']);
  assert.match(month.note, /1 entries have no date/);
  const year = L.summary({ period: 'this_year' });
  assert.deepEqual([year.revenue, year.spending], [35000, 1000]);
  const last = L.summary({ period: 'last_year' });
  assert.deepEqual([last.revenue, last.spending, last.from, last.to], [0, 500, '2025-01-01', '2025-12-31']);
  const twelve = L.summary({ period: 'last_12_months' });
  assert.deepEqual([twelve.revenue, twelve.spending, twelve.from], [35000, 1500, '2025-11-01']);
  const range = L.summary({ from: '2026-03-01', to: '2026-03-31' });
  assert.equal(range.revenue, 15000);
  assert.equal(L.summary({ period: 'last_month' }).revenue, 0);
});

test('financial year runs April to March', async t => {
  const { db } = setup(t);
  const L = await load(db);
  const fy = L.summary({ period: 'this_fy' });
  assert.deepEqual([fy.period, fy.from, fy.to, fy.revenue, fy.spending], ['FY 2026–27', '2026-04-01', '2027-03-31', 20000, 1000]);
  assert.match(fy.note, /1 entries have no date/);
  const last = L.summary({ period: 'last_fy' });
  assert.deepEqual([last.period, last.from, last.to, last.revenue, last.spending], ['FY 2025–26', '2025-04-01', '2026-03-31', 15000, 500]);
  const c = L.comparePeriods({ preset: 'fy_vs_last_fy' });
  assert.deepEqual([c.current.period, c.previous.period, c.change.revenue], ['FY 2026–27', 'FY 2025–26', { difference: 5000, percent: 33 }]);
});

test('31 March and 1 April land in different financial years', async t => {
  const { db, store } = setup(t);
  store.insert('txns', { client_id: ids.geekboz, type: 'in', amount: 100, date: '2026-03-31' }, OWNER);
  store.insert('txns', { client_id: ids.geekboz, type: 'in', amount: 1, date: '2026-04-01' }, OWNER);
  let L = await load(db);
  assert.equal(L.summary({ period: 'last_fy' }).revenue, 15100);
  assert.equal(L.summary({ period: 'this_fy' }).revenue, 20001);
  // The year turns over at midnight in India, not UTC.
  t.mock.timers.setTime(Date.parse('2027-03-31T18:00:00Z')); // 23:30 on 31 March in India
  L = await load(db);
  assert.equal(L.summary({ period: 'this_fy' }).from, '2026-04-01');
  t.mock.timers.setTime(Date.parse('2027-03-31T18:40:00Z')); // 00:10 on 1 April in India
  L = await load(db);
  assert.deepEqual([L.summary({ period: 'this_fy' }).from, L.summary({ period: 'last_fy' }).from], ['2027-04-01', '2026-04-01']);
  t.mock.timers.setTime(Date.parse('2026-02-10T06:30:00Z')); // January to March still belongs to the year that began last April
  assert.equal((await load(db)).summary({ period: 'this_fy' }).period, 'FY 2025–26');
});

test('summary groups money by month and ranks projects by profit', async t => {
  const { db } = setup(t);
  const s = (await load(db)).summary();
  assert.deepEqual(s.byMonth.map(m => m.month), ['2025-12', '2026-03', '2026-10']);
  assert.deepEqual(s.byMonth.find(m => m.month === '2026-10'), { month: '2026-10', revenue: 20000, spending: 1000, profit: 19000 });
  assert.deepEqual(s.projectsByProfit.map(p => [p.client, p.project, p.profit]), [['Edustudy', 'Website', 20000], ['GeekBoz', 'Website', 19000]]);
});

test('months roll back across the new year', async t => {
  const { db } = setup(t);
  t.mock.timers.setTime(Date.parse('2026-01-15T06:30:00Z'));
  const L = await load(db);
  const last = L.summary({ period: 'last_month' });
  assert.deepEqual([last.from, last.to], ['2025-12-01', '2025-12-31']);
  assert.equal(last.spending, 500);
});

test('compare periods', async t => {
  const { db } = setup(t);
  const L = await load(db);
  const c = L.comparePeriods();
  assert.equal(c.current.period, 'This month');
  assert.deepEqual(c.change.revenue, { difference: 20000, percent: null });
  const y = L.comparePeriods({ preset: 'year_vs_last_year' });
  assert.deepEqual([y.current.revenue, y.previous.revenue, y.change.spending.percent], [35000, 0, 100]);
  const custom = L.comparePeriods({ a_from: '2026-10-01', a_to: '2026-10-31', b_from: '2026-03-01', b_to: '2026-03-31' });
  assert.deepEqual([custom.current.revenue, custom.previous.revenue, custom.change.revenue.percent], [20000, 15000, 33]);
  assert.match(c.note, /without a date/);
});

test('attention items', async t => {
  const { db } = setup(t);
  const a = (await load(db)).attention();
  assert.equal(a.today, '2026-10-23');
  assert.deepEqual(a.overdueProjects.map(p => p.project), ['Website (GeekBoz)']);
  assert.deepEqual(a.stillToCollect.map(o => [o.project, o.stillToCollect, o.lastPayment]), [['Website', 30000, '2026-10-05']]);
  assert.deepEqual(a.openLeads.map(p => p.project), ['App (Edustudy)']);
  assert.deepEqual(a.missingInfo.projectsWithoutLiveLink, ['Website (Edustudy)']);
  assert.equal(a.missingInfo.entriesWithoutDate, 1);
  t.mock.timers.setTime(Date.parse('2026-10-15T06:30:00Z'));
  const early = (await load(db)).attention();
  assert.deepEqual([early.overdueProjects.length, early.dueWithinAWeek.map(p => p.dueDate)], [0, ['2026-10-20']]);
});

test('milestones are covered in order by the project\'s money in', async t => {
  const { db, store } = setup(t);
  let L = await load(db);
  const states = name => L.getProject({ project: name }).milestones.map(m => [m.name, m.state, m.paid, m.left]);
  // 20,000 received covers the advance exactly; Design is past due; Launch is due next week.
  assert.deepEqual(states('GeekBoz Website'), [['Advance', 'paid', 20000, 0], ['Design', 'overdue', 0, 15000], ['Launch', 'unpaid', 0, 15000]]);
  assert.equal(L.getProject({ project: 'GeekBoz Website' }).milestones[1].daysOverdue, 8);
  assert.deepEqual(states('App'), [['Advance', 'unpaid', 0, 40000]]); // a lead's milestones are never overdue
  assert.equal(L.getProject({ project: 'Edustudy Website' }).milestones, undefined);
  // A payment covering part of milestone 2: still overdue, now part paid.
  store.insert('txns', { client_id: ids.geekboz, project_id: ids.gbSite, type: 'in', amount: 5000, date: '2026-10-22' }, OWNER);
  L = await load(db);
  assert.deepEqual(states('GeekBoz Website'), [['Advance', 'paid', 20000, 0], ['Design', 'overdue', 5000, 10000], ['Launch', 'unpaid', 0, 15000]]);
  assert.equal(L.getProject({ project: 'GeekBoz Website' }).money.overdue, 10000);
  // Before its due date, the same milestone is just part paid.
  t.mock.timers.setTime(Date.parse('2026-10-10T06:30:00Z'));
  L = await load(db);
  assert.deepEqual(states('GeekBoz Website')[1], ['Design', 'part-paid', 5000, 10000]);
  // Its due date itself isn't overdue yet.
  t.mock.timers.setTime(Date.parse('2026-10-15T06:30:00Z'));
  L = await load(db);
  assert.equal(states('GeekBoz Website')[1][1], 'part-paid');
});

test('overdue and soon-due milestones in attention items and the summary', async t => {
  const { db } = setup(t);
  const L = await load(db);
  const a = L.attention();
  assert.deepEqual(a.overdueMilestones.map(m => [m.project, m.milestone, m.left, m.dueDate, m.daysOverdue]), [['Website (GeekBoz)', 'Design', 15000, '2026-10-15', 8]]);
  assert.deepEqual(a.milestonesDueWithinAWeek.map(m => [m.milestone, m.dueDate]), [['Launch', '2026-10-28']]);
  const s = L.summary();
  assert.equal(s.overdueFromMilestones, 15000);
  assert.deepEqual([s.overdueMilestones.length, s.milestonesDueWithinAWeek.length], [1, 1]);
  assert.equal(L.listProjects({ client: 'GeekBoz' }).projects[0].money.overdue, 15000);
});

test('finding clients and projects by name', async t => {
  const { db } = setup(t);
  const L = await load(db);
  assert.equal(L.resolveClient('geekboz').client.id, ids.geekboz);
  assert.equal(L.resolveClient('edu').client.id, ids.edustudy);
  assert.match(L.resolveClient('nobody').error, /No client matches/);
  const both = L.resolveProject('Website');
  assert.match(both.error, /Several projects/);
  assert.equal(both.matches.length, 2);
  assert.equal(L.resolveProject('GeekBoz Website').project.id, ids.gbSite);
  assert.equal(L.resolveProject('website for edustudy').project.id, ids.eduSite);
  assert.equal(L.resolveProject('Website', 'Edustudy').project.id, ids.eduSite);
  assert.equal(L.resolveProject(ids.eduApp).project.title, 'App');
  assert.match(L.resolveProject('Shop').error, /No project matches/);
});

test('project, client and money lists', async t => {
  const { db } = setup(t);
  const L = await load(db);
  const gb = L.getProject({ project: 'GeekBoz Website' });
  assert.deepEqual(gb.money, { quoted: 50000, received: 20000, spent: 1000, profit: 19000, stillToCollect: 30000, percentPaid: 40, overdue: 15000 });
  assert.equal(gb.overdue, true);
  assert.equal(gb.transactions.length, 2);
  assert.equal(L.getProject({ project: 'App' }).money.stillToCollect, 0); // leads aren't owed anything
  assert.deepEqual(L.listProjects({ status: 'open' }).projects.map(p => p.title).sort(), ['App', 'Website']);
  assert.equal(L.listProjects({ status: 'In progress' }).count, 1);
  assert.equal(L.listProjects({ client: 'edu' }).count, 2);
  const clients = L.listClients().clients;
  assert.deepEqual(clients.map(c => [c.name, c.revenue, c.stillToCollect]), [['GeekBoz', 20000, 30000], ['Edustudy', 20000, 0]]);
  assert.equal(L.getClient({ client: 'Edustudy' }).transactions.length, 3);
  const out = L.listTransactions({ type: 'out' });
  assert.deepEqual([out.count, out.spending], [2, 1500]);
  assert.equal(L.listTransactions({ category: 'hosting' }).count, 1);
  assert.equal(L.listTransactions({ limit: 2 }).transactions.length, 2);
  assert.match(L.listTransactions({ limit: 2 }).truncated, /newest 2 of 5/);
});

test('search', async t => {
  const { db } = setup(t);
  const L = await load(db);
  const r = L.search({ query: 'advance' });
  assert.deepEqual(r.transactions.map(x => x.amount), [20000]);
  assert.deepEqual(L.search({ query: 'edustudy.in' }).clients.map(c => c.name), ['Edustudy']);
  assert.ok(L.search({ query: '' }).error);
});

test('only the signed-in user\'s rows are loaded', async t => {
  const { db, otherDb } = setup(t);
  const mine = await load(db), theirs = await load(otherDb);
  assert.equal(mine.clients.length, 2);
  assert.ok(!mine.txns.some(x => x.amount === 77777));
  assert.deepEqual(theirs.summary().revenue, 77777);
  assert.equal(theirs.projects.length, 1);
});
