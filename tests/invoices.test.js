// Invoice numbers, states, the UPI link, overdue lists and reminder facts, from the seed ledger (see tests/helpers/seed.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers/setup');
const { ids, OWNER } = require('./helpers/seed');
const { load, nextInvoiceNumber, whatsappNumber } = require('../api/_lib/ledger');

const byNumber = (L, n) => L.invoiceSummary(L.invoices.find(i => i.number === n));

test('invoice states come from the payments linked to them', async t => {
  const { db, store } = setup(t);
  const L = await load(db);
  assert.deepEqual(['INV/2026-27/001', 'INV/2026-27/002', 'INV/2026-27/003', 'INV/2025-26/001', 'INV/2025-26/002'].map(n => { const x = byNumber(L, n); return [x.state, x.paid, x.due]; }),
    [['paid', 20000, 0], ['overdue', 0, 15000], ['draft', 0, 2500], ['paid', 15000, 0], ['cancelled', 0, 0]]);
  assert.equal(byNumber(L, 'INV/2026-27/002').daysOverdue, 8);
  assert.deepEqual(byNumber(L, 'INV/2026-27/002').reminders, { count: 1, last: '2026-10-18' });
  // A part payment: still overdue, with less due. Before the due date it's part paid.
  store.insert('txns', { client_id: ids.geekboz, project_id: ids.gbSite, type: 'in', amount: 5000, date: '2026-10-22', invoice_id: ids.invDesign }, OWNER);
  let L2 = await load(db);
  assert.deepEqual([byNumber(L2, 'INV/2026-27/002').state, byNumber(L2, 'INV/2026-27/002').due], ['overdue', 10000]);
  t.mock.timers.setTime(Date.parse('2026-10-12T06:30:00Z'));
  L2 = await load(db);
  assert.equal(byNumber(L2, 'INV/2026-27/002').state, 'part-paid');
  t.mock.timers.setTime(Date.parse('2026-10-15T06:30:00Z')); // the due date itself isn't overdue
  assert.equal(byNumber(await load(db), 'INV/2026-27/002').state, 'part-paid');
});

test('lists, filters and finding an invoice by its number', async t => {
  const { db } = setup(t);
  const L = await load(db);
  const nums = f => L.listInvoices({ filter: f }).invoices.map(i => i.number);
  assert.deepEqual(nums('open'), ['INV/2026-27/002']);
  assert.deepEqual(nums('overdue'), ['INV/2026-27/002']);
  assert.deepEqual(nums('draft'), ['INV/2026-27/003']);
  assert.deepEqual(nums('paid'), ['INV/2026-27/001', 'INV/2025-26/001']);
  assert.deepEqual(nums('cancelled'), ['INV/2025-26/002']);
  assert.equal(L.listInvoices({ filter: 'all' }).count, 5); // the other user's invoice isn't there
  assert.equal(L.listInvoices({ filter: 'all', client: 'edu' }).count, 3);
  assert.match(L.listInvoices({ filter: 'nope' }).error, /filter must be/);
  assert.equal(L.resolveInvoice('INV/2026-27/002').invoice.id, ids.invDesign);
  assert.equal(L.resolveInvoice('002').invoice.id, ids.invDesign, 'a short number means this financial year');
  assert.equal(L.resolveInvoice('2025-26/002').invoice.id, ids.invCancelled);
  assert.equal(L.resolveInvoice('003').invoice.id, ids.invDraft);
  assert.match(L.resolveInvoice('009').error, /No invoice matches/);
  const g = L.getInvoice({ invoice: '003' });
  assert.deepEqual(g.items.map(i => i.amount), [500, 2000]);
  assert.deepEqual([g.total, g.client, g.project, g.notes], [2500, 'Edustudy', null, null]);
  assert.deepEqual(L.getInvoice({ invoice: '001' }).payments.map(p => [p.amount, p.invoice]), [[20000, 'INV/2026-27/001']]);
});

test('the UPI link is for the amount still due', async t => {
  const { db } = setup(t);
  const L = await load(db);
  const inv = n => L.invoices.find(i => i.number === n);
  assert.equal(L.upiLink(inv('INV/2026-27/002')), 'upi://pay?pa=mec%40okhdfcbank&pn=Mec%20Web%20Studio&am=15000.00&cu=INR&tn=INV%2F2026-27%2F002');
  assert.equal(L.upiLink(inv('INV/2026-27/001')), null, 'nothing due');
  const noUpi = await load(db);
  noUpi.settings.upiId = '';
  assert.equal(noUpi.upiLink(inv('INV/2026-27/002')), null);
});

test('numbers restart each financial year, and are never reused', () => {
  const used = ['INV/2026-27/001', 'INV/2026-27/002', 'INV/2025-26/001', 'INV/2025-26/002', 'ABC/2026-27/009'];
  assert.equal(nextInvoiceNumber(used, 'INV', '2026-10-23'), 'INV/2026-27/003');
  assert.equal(nextInvoiceNumber(used, 'INV', '2027-03-31'), 'INV/2026-27/003');
  assert.equal(nextInvoiceNumber(used, 'INV', '2027-04-01'), 'INV/2027-28/001');
  assert.equal(nextInvoiceNumber(used, 'INV', '2026-02-01'), 'INV/2025-26/003'); // cancelled 002 still counts
  assert.equal(nextInvoiceNumber(used, 'ABC', '2026-05-01'), 'ABC/2026-27/010');
  assert.equal(nextInvoiceNumber([], 'INV', '2026-04-01'), 'INV/2026-27/001');
  assert.equal(nextInvoiceNumber(['INV/2026-27/999'], 'INV', '2026-04-01'), 'INV/2026-27/1000');
});

test('overdue invoices by client, in the summary and attention items', async t => {
  const { db } = setup(t);
  const L = await load(db);
  const o = L.listOverdue();
  assert.equal(o.totalOverdue, 15000);
  assert.deepEqual(o.clients.map(c => [c.client, c.due, c.mostDaysOverdue, c.invoices.length]), [['GeekBoz', 15000, 8, 1]]);
  assert.deepEqual(L.summary().invoices, { unpaid: 15000, unpaidCount: 1, overdue: 15000, overdueCount: 1, drafts: 1 });
  assert.deepEqual(L.attention().overdueInvoices.map(i => i.number), ['INV/2026-27/002']);
});

test('reminder facts: tone gets firmer after 7 and 30 days, and WhatsApp numbers', async t => {
  const { db } = setup(t);
  let f = (await load(db)).reminderFacts({ client: 'GeekBoz' });
  assert.deepEqual([f.client, f.totalDue, f.tone, f.whatsappNumber], ['GeekBoz', 15000, 'firm', '919876543210']); // 8 days overdue
  assert.deepEqual(f.invoices.map(i => [i.number, i.daysOverdue, i.timesReminded, i.lastReminded]), [['INV/2026-27/002', 8, 1, '2026-10-18']]);
  assert.match(f.invoices[0].upiLink, /^upi:\/\/pay\?/);
  assert.match(f.note, /never sends/);
  assert.match((await load(db)).reminderFacts({ client: 'Edustudy' }).error, /Nothing is owed/); // only a draft
  t.mock.timers.setTime(Date.parse('2026-10-18T06:30:00Z'));
  assert.equal((await load(db)).reminderFacts({ invoice: '002' }).tone, 'friendly');
  t.mock.timers.setTime(Date.parse('2026-11-20T06:30:00Z'));
  assert.equal((await load(db)).reminderFacts({ invoice: '002' }).tone, 'final');
  assert.equal(whatsappNumber('98765 43210'), '919876543210');
  assert.equal(whatsappNumber('Call +91 98765-43210 after 6'), '919876543210');
  assert.equal(whatsappNumber('+44 7700 900123'), '447700900123');
  assert.equal(whatsappNumber('hello@edustudy.in'), null);
  assert.equal(whatsappNumber(''), null);
});
