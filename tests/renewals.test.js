// Renewals: date maths for each cycle, what's due, yearly profit, from the seed ledger (see tests/helpers/seed.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers/setup');
const { ids } = require('./helpers/seed');
const { load, addMonths } = require('../api/_lib/ledger');

test('a cycle moves the date by whole months, landing on the last day of shorter months', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2028-01-31', 1), '2028-02-29'); // leap year
  assert.equal(addMonths('2026-03-31', 1), '2026-04-30');
  assert.equal(addMonths('2026-11-30', 3), '2027-02-28');
  assert.equal(addMonths('2026-12-15', 1), '2027-01-15');
  assert.equal(addMonths('2028-02-29', 12), '2029-02-28');
  assert.equal(addMonths('2027-02-28', 12), '2028-02-28');
  assert.equal(addMonths('2026-10-20', 12), '2027-10-20');
});

test('what is due, overdue, and yearly profit from active services', async t => {
  const { db } = setup(t);
  const L = await load(db);
  const r = L.listRenewals();
  assert.deepEqual(r.yearly, { revenue: 31500, cost: 3800, profit: 27700 });
  assert.deepEqual(r.overdue.map(x => [x.name, x.daysUntilRenewal]), [['Hostinger Business', -3]]);
  assert.deepEqual(r.due.map(x => [x.name, x.daysUntilRenewal]), [['geekboz.in', 13]]);
  assert.deepEqual(r.services.map(x => x.name), ['Hostinger Business', 'geekboz.in', 'Monthly care plan']); // the stopped one and the other user's are left out
  assert.equal(L.listRenewals({ include_inactive: true }).services.length, 4);
  assert.deepEqual(L.listRenewals({ within_days: 60 }).due.map(x => x.name), ['geekboz.in', 'Monthly care plan']);
  const care = r.services.find(x => x.name === 'Monthly care plan');
  assert.deepEqual([care.yearlyProfit, care.client, care.project, care.cycle], [24000, 'Edustudy', 'Website', 'monthly']);
  assert.deepEqual(L.attention().renewalsDue.map(x => x.name), ['Hostinger Business', 'geekboz.in']);
  assert.deepEqual(L.getClient({ client: 'GeekBoz' }).services.map(x => [x.name, x.provider, x.autoRenew]), [['geekboz.in', 'GoDaddy', false], ['Hostinger Business', 'Hostinger', true]]);
  assert.equal(L.resolveService('geekboz.in').service.id, ids.svcDomain);
  assert.match(L.resolveService('nothing').error, /No service matches/);
});
