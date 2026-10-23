// Every change tool: what it saves, what it refuses, and that undo_change puts the data back exactly.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers/setup');
const { ids, OWNER, OTHER } = require('./helpers/seed');
const { TOOLS } = require('../api/_lib/tools');
const { Invalid } = require('../api/_lib/writes');

const call = (db, name, args = {}) => TOOLS.find(x => x.name === name).run(db, args);
const rows = (store, table, uid) => store.rows[table].filter(r => !uid || r.user_id === uid);
const theirs = store => JSON.stringify(Object.values(store.rows).flat().filter(r => r.user_id === OTHER));

// Runs a change, checks it did something, then undoes it and checks every table is exactly as before.
async function changeAndUndo(t, ctx, name, args, check) {
  const before = ctx.store.snapshot(), other = theirs(ctx.store);
  const r = await call(ctx.db, name, args);
  assert.equal(r.done, true, JSON.stringify(r));
  assert.ok(r.change_id);
  if (check) await check(r);
  assert.notDeepEqual(ctx.store.snapshot(), before, name + ' changed nothing');
  const u = await call(ctx.db, 'undo_change', { change_id: r.change_id });
  assert.equal(u.done, true, JSON.stringify(u));
  assert.deepEqual(ctx.store.snapshot(), before, 'undo of ' + name + ' left the data different');
  assert.equal(theirs(ctx.store), other, name + ' touched another user\'s rows');
  return r;
}

test('add a client, refuse a duplicate, undo', async t => {
  const ctx = setup(t);
  await changeAndUndo(t, ctx, 'create_client', { name: 'Sweet Crumbs', contact: '99999 00000' }, () => {
    const c = rows(ctx.store, 'clients').find(c => c.name === 'Sweet Crumbs');
    assert.deepEqual([c.contact, c.notes, c.sort_order], ['99999 00000', '', 2]);
  });
  const dupe = await call(ctx.db, 'create_client', { name: 'geekboz' });
  assert.match(dupe.error, /already exists/);
  assert.equal(rows(ctx.store, 'clients').length, 3); // 2 of the owner's + 1 of the other user's
  const again = await call(ctx.db, 'create_client', { name: 'GeekBoz', allow_duplicate: true });
  assert.equal(again.done, true);
  await assert.rejects(call(ctx.db, 'create_client', { name: '   ' }), Invalid);
});

test('edit a client', async t => {
  const ctx = setup(t);
  await changeAndUndo(t, ctx, 'update_client', { client: 'GeekBoz', notes: 'Pays on time' }, () => {
    assert.equal(ctx.store.rows.clients.find(c => c.id === ids.geekboz).notes, 'Pays on time');
  });
  await assert.rejects(call(ctx.db, 'update_client', { client: 'GeekBoz' }), /Say what to change/);
});

test('delete a client: preview first, then everything goes, and undo brings it all back', async t => {
  const ctx = setup(t);
  const before = ctx.store.snapshot();
  const preview = await call(ctx.db, 'delete_client', { client: 'Edustudy' });
  assert.equal(preview.confirmation_required, true);
  assert.deepEqual([preview.projects.sort(), preview.transactions, preview.moneyIn, preview.moneyOut], [['App', 'Website'], 3, 20000, 500]);
  assert.deepEqual(ctx.store.snapshot(), before);
  await changeAndUndo(t, ctx, 'delete_client', { client: 'Edustudy', confirm: true }, () => {
    assert.equal(rows(ctx.store, 'projects').filter(p => p.client_id === ids.edustudy).length, 0);
    assert.ok(!rows(ctx.store, 'milestones').some(m => m.id === ids.msLead));
    assert.equal(rows(ctx.store, 'txns').filter(x => x.client_id === ids.edustudy).length, 0);
  });
});

test('add a project for a new client only when asked', async t => {
  const ctx = setup(t);
  const before = ctx.store.snapshot();
  const r = await call(ctx.db, 'create_project', { title: 'Booking site', client: 'Sweet Crumbs', quoted: 40000 });
  assert.match(r.error, /No client matches/);
  assert.match(r.hint, /new_client: true/);
  assert.deepEqual(ctx.store.snapshot(), before);
  await changeAndUndo(t, ctx, 'create_project', { title: 'Booking site', client: 'Sweet Crumbs', new_client: true, quoted: 40000, live_url: 'sweetcrumbs.in', due_date: '2026-12-01' }, res => {
    assert.equal(res.project.newClient, true);
    const p = rows(ctx.store, 'projects').find(p => p.name === 'Booking site');
    assert.deepEqual([p.status, Number(p.quoted), p.live_url, p.due_date, p.preview_url], ['active', 40000, 'https://sweetcrumbs.in/', '2026-12-01', '']);
  });
});

test('project fields are checked', async t => {
  const ctx = setup(t);
  const add = a => call(ctx.db, 'create_project', { title: 'X', client: 'GeekBoz', ...a });
  await assert.rejects(add({ live_url: 'javascript:alert(1)' }), /doesn't look like a web address/);
  await assert.rejects(add({ due_date: '2026-02-30' }), /real date/);
  await assert.rejects(add({ quoted: -5 }), /Quoted price/);
  await assert.rejects(add({ status: 'archived' }), /Status must be/);
  assert.equal((await add({ status: 'in progress' })).done, true);
  assert.equal(rows(ctx.store, 'projects').find(p => p.name === 'X').status, 'active');
  assert.match((await add({})).error, /already has a project called "X"/);
});

test('edit a project, including moving it to another client with its money', async t => {
  const ctx = setup(t);
  await changeAndUndo(t, ctx, 'update_project', { project: 'GeekBoz Website', status: 'done', live_url: 'https://geekboz.com' }, r => {
    assert.equal(r.project.status, 'Done');
  });
  await changeAndUndo(t, ctx, 'update_project', { project: 'App', move_to_client: 'GeekBoz' });
  await changeAndUndo(t, ctx, 'update_project', { project: 'Website', client: 'Edustudy', move_to_client: 'GeekBoz' }, () => {
    assert.ok(rows(ctx.store, 'txns').filter(x => x.project_id === ids.eduSite).every(x => x.client_id === ids.geekboz));
  });
  const vague = await call(ctx.db, 'update_project', { project: 'Website', status: 'done' });
  assert.match(vague.error, /Several projects/);
});

test('delete a project keeps its money under "No project" unless asked', async t => {
  const ctx = setup(t);
  const preview = await call(ctx.db, 'delete_project', { project: 'GeekBoz Website' });
  assert.deepEqual([preview.confirmation_required, preview.milestones], [true, 3]);
  await changeAndUndo(t, ctx, 'delete_project', { project: 'GeekBoz Website', confirm: true }, () => {
    assert.deepEqual(rows(ctx.store, 'txns').filter(x => [ids.advance, ids.domain].includes(x.id)).map(x => x.project_id), [null, null]);
    assert.equal(rows(ctx.store, 'milestones').filter(m => m.project_id === ids.gbSite).length, 0); // undo brings them back
  });
  await changeAndUndo(t, ctx, 'delete_project', { project: 'GeekBoz Website', delete_transactions: true, confirm: true }, () => {
    assert.ok(!rows(ctx.store, 'txns').some(x => x.id === ids.advance));
  });
});

test('set milestones from a split: whole rupees, the last part takes the rest, one undo restores the old list', async t => {
  const ctx = setup(t);
  const ms = () => rows(ctx.store, 'milestones').filter(m => m.project_id === ids.gbSite).sort((a, b) => a.sort_order - b.sort_order);
  await changeAndUndo(t, ctx, 'set_milestones', { project: 'GeekBoz Website', split: [50, 30, 20], due_dates: ['2026-10-01', '2026-11-15'] }, r => {
    assert.deepEqual(ms().map(m => [m.name, Number(m.amount), m.due_date, m.sort_order]),
      [['Advance', 25000, '2026-10-01', 0], ['Payment 2', 15000, '2026-11-15', 1], ['Final payment', 10000, null, 2]]);
    assert.ok(!ctx.store.rows.milestones.some(m => m.id === ids.msDesign), 'the old list is replaced');
    // 20,000 received covers part of the advance, which is past due.
    assert.deepEqual(r.milestones.map(m => [m.state, m.paid, m.left]), [['overdue', 20000, 5000], ['unpaid', 0, 15000], ['unpaid', 0, 10000]]);
    assert.equal(r.warning, undefined);
  });
  await changeAndUndo(t, ctx, 'set_milestones', { project: 'GeekBoz Website', split: [33.33, 33.33, 33.34] }, () => {
    assert.deepEqual(ms().map(m => Number(m.amount)), [16665, 16665, 16670]);
  });
  await changeAndUndo(t, ctx, 'set_milestones', { project: 'GeekBoz Website', split: [100] }, () => {
    assert.deepEqual(ms().map(m => [m.name, Number(m.amount)]), [['Full payment', 50000]]);
  });
});

test('set milestones from a list, warn when they don\'t add up to the quote, and remove them all', async t => {
  const ctx = setup(t);
  await changeAndUndo(t, ctx, 'set_milestones', { project: 'Website', client: 'GeekBoz', milestones: [{ name: 'Advance', amount: 10000 }, { amount: '₹20,000', due_date: '2026-12-01' }] }, r => {
    assert.deepEqual(r.milestones.map(m => [m.name, m.amount, m.dueDate, m.state]), [['Advance', 10000, null, 'paid'], ['Final payment', 20000, '2026-12-01', 'part-paid']]);
    assert.match(r.warning, /add up to ₹30,000, but the quote is ₹50,000/);
  });
  await changeAndUndo(t, ctx, 'set_milestones', { project: 'GeekBoz Website', milestones: [] }, r => {
    assert.match(r.message, /Removed the milestones/);
    assert.equal(rows(ctx.store, 'milestones').filter(m => m.project_id === ids.gbSite).length, 0);
  });
  assert.match((await call(ctx.db, 'set_milestones', { project: 'Edustudy Website', milestones: [] })).error, /no milestones to remove/);
});

test('set milestones refuses bad input and changes nothing', async t => {
  const ctx = setup(t);
  const before = ctx.store.snapshot();
  const set = a => call(ctx.db, 'set_milestones', { project: 'GeekBoz Website', ...a });
  await assert.rejects(set({}), /either a split/);
  await assert.rejects(set({ split: [50, 50], milestones: [] }), /either a split/);
  await assert.rejects(set({ split: [50, 40] }), /add up to 100/);
  await assert.rejects(set({ split: [50, -10, 60] }), /above 0/);
  await assert.rejects(set({ split: [50, 50], due_dates: ['2026-02-30'] }), /real date/);
  await assert.rejects(set({ milestones: [{ name: 'Advance', amount: 0 }] }), /above 0/);
  ctx.store.insert('projects', { client_id: ids.geekboz, name: 'Free site', quoted: 0 }, OWNER);
  const after = ctx.store.snapshot();
  await assert.rejects(call(ctx.db, 'set_milestones', { project: 'Free site', split: [50, 50] }), /no quoted price/);
  assert.deepEqual(ctx.store.snapshot(), after);
  assert.notDeepEqual(after, before);
});

test('undoing a new project is refused once milestones were set on it', async t => {
  const ctx = setup(t);
  const made = await call(ctx.db, 'create_project', { title: 'Shop', client: 'GeekBoz', quoted: 10000 });
  const set = await call(ctx.db, 'set_milestones', { project: 'GeekBoz Shop', split: [50, 50] });
  assert.match((await call(ctx.db, 'undo_change', { change_id: made.change_id })).error, /newer item/);
  assert.equal((await call(ctx.db, 'undo_change', { change_id: set.change_id })).done, true);
  assert.equal((await call(ctx.db, 'undo_change', { change_id: made.change_id })).done, true);
  assert.ok(!rows(ctx.store, 'projects').some(p => p.name === 'Shop'));
});

const inv = (store, number) => store.rows.invoices.find(i => i.number === number && i.user_id === OWNER);

test('create an invoice from a milestone: next number, due after the payment terms, draft by default', async t => {
  const ctx = setup(t);
  await changeAndUndo(t, ctx, 'create_invoice', { project: 'GeekBoz Website', milestone: 'Launch' }, r => {
    const row = inv(ctx.store, 'INV/2026-27/004');
    assert.deepEqual([row.client_id, row.project_id, row.milestone_id, row.issue_date, row.due_date, Number(row.total), row.status, row.notes, row.sent_at],
      [ids.geekboz, ids.gbSite, ids.msLaunch, '2026-10-23', '2026-10-30', 15000, 'draft', 'Thank you!', null]);
    assert.deepEqual(row.items, [{ description: 'Website — Launch', quantity: 1, rate: 15000 }]);
    assert.equal(r.invoice.state, 'draft');
    assert.match(r.invoice.upiLink, /am=15000\.00/);
    assert.equal(r.setupNeeded, undefined);
  });
  assert.match((await call(ctx.db, 'create_invoice', { project: 'GeekBoz Website', milestone: 'Design' })).error, /INV\/2026-27\/002 already invoices this milestone/);
  assert.match((await call(ctx.db, 'create_invoice', { project: 'GeekBoz Website', milestone: 'Advance' })).error, /already paid/);
  assert.match((await call(ctx.db, 'create_invoice', { project: 'GeekBoz Website', milestone: 'Nope' })).error, /No milestone/);
  const dupe = await call(ctx.db, 'create_invoice', { project: 'GeekBoz Website', milestone: 'Design', allow_duplicate: true });
  assert.equal(dupe.invoice.number, 'INV/2026-27/004');
});

test('create an invoice from line items, already sent, and across 1 April', async t => {
  const ctx = setup(t);
  await changeAndUndo(t, ctx, 'create_invoice', { client: 'Edustudy', items: [{ description: 'Logo', rate: 3000 }, { description: 'Pages', quantity: 3, rate: '₹1,500' }], mark_sent: true, notes: 'UPI preferred' }, r => {
    const row = inv(ctx.store, 'INV/2026-27/004');
    assert.deepEqual([Number(row.total), row.status, row.notes, row.project_id, !!row.sent_at], [7500, 'sent', 'UPI preferred', null, true]);
    assert.equal(r.invoice.state, 'unpaid');
  });
  await changeAndUndo(t, ctx, 'create_invoice', { client: 'Edustudy', items: [{ description: 'Support', rate: 1000 }], issue_date: '2027-04-01', due_date: '2027-04-15' }, r => {
    assert.equal(r.invoice.number, 'INV/2027-28/001');
  });
  await changeAndUndo(t, ctx, 'create_invoice', { client: 'Edustudy', items: [{ description: 'Support', rate: 1000 }], issue_date: '2027-03-31' }, r => {
    assert.deepEqual([r.invoice.number, r.invoice.dueDate], ['INV/2026-27/004', '2027-04-07']);
  });
  const add = a => call(ctx.db, 'create_invoice', { client: 'Edustudy', ...a });
  await assert.rejects(add({}), /at least one line item/);
  await assert.rejects(add({ items: [{ description: '', rate: 100 }] }), /needs a description/);
  await assert.rejects(add({ items: [{ description: 'X', rate: 0 }] }), /above 0/);
  await assert.rejects(add({ items: [{ description: 'X', quantity: -1, rate: 10 }] }), /quantity/);
  await assert.rejects(add({ items: [{ description: 'X', rate: 10 }], issue_date: '2026-10-10', due_date: '2026-10-01' }), /before the issue date/);
  await assert.rejects(call(ctx.db, 'create_invoice', { items: [{ description: 'X', rate: 10 }] }), /which client/);
});

test('send, edit and cancel an invoice; a cancelled one is never owed', async t => {
  const ctx = setup(t);
  await changeAndUndo(t, ctx, 'update_invoice', { invoice: '003', status: 'sent' }, r => {
    assert.ok(inv(ctx.store, 'INV/2026-27/003').sent_at);
    assert.equal(r.invoice.state, 'unpaid');
  });
  await changeAndUndo(t, ctx, 'update_invoice', { invoice: '003', items: [{ description: 'Hosting renewal', rate: 800 }], due_date: '' }, r => {
    assert.deepEqual([Number(inv(ctx.store, 'INV/2026-27/003').total), r.invoice.dueDate], [800, null]);
  });
  await changeAndUndo(t, ctx, 'update_invoice', { invoice: 'INV/2026-27/002', status: 'cancelled' }, async r => {
    assert.deepEqual([r.invoice.state, r.invoice.due], ['cancelled', 0]);
    assert.equal((await call(ctx.db, 'list_overdue')).totalOverdue, 0);
  });
  await assert.rejects(call(ctx.db, 'update_invoice', { invoice: '2025-26/002', notes: 'x' }), /is cancelled/);
  await assert.rejects(call(ctx.db, 'update_invoice', { invoice: '002', status: 'paid' }), /worked out from the payments/);
  await assert.rejects(call(ctx.db, 'update_invoice', { invoice: '002' }), /Say what to change/);
  assert.match((await call(ctx.db, 'update_invoice', { invoice: '077', status: 'sent' })).error, /No invoice matches/);
});

test('a payment for an invoice settles it, and unlinking the payment reopens it', async t => {
  const ctx = setup(t);
  await changeAndUndo(t, ctx, 'add_payment', { amount: 15000, invoice: '002', note: 'Design' }, async r => {
    const tx = rows(ctx.store, 'txns').find(x => x.note === 'Design');
    assert.deepEqual([tx.invoice_id, tx.client_id, tx.project_id], [ids.invDesign, ids.geekboz, ids.gbSite]);
    assert.equal(r.entries[0].invoice, 'INV/2026-27/002');
    assert.equal((await call(ctx.db, 'get_invoice', { invoice: '002' })).state, 'paid');
  });
  await changeAndUndo(t, ctx, 'update_transaction', { id: ids.advance, invoice: '' }, async () => {
    assert.equal(rows(ctx.store, 'txns').find(x => x.id === ids.advance).invoice_id, null);
    const g = await call(ctx.db, 'get_invoice', { invoice: '001' });
    assert.deepEqual([g.state, g.due], ['overdue', 20000]);
  });
  assert.match((await call(ctx.db, 'add_payment', { amount: 100, invoice: '2025-26/002' })).error, /cancelled/);
  await assert.rejects(call(ctx.db, 'add_expense', { amount: 100, invoice: '002' }), /Only payments/);
});

test('log a reminder, and refuse when nothing is owed', async t => {
  const ctx = setup(t);
  await changeAndUndo(t, ctx, 'log_reminder', { client: 'GeekBoz' }, r => {
    const row = inv(ctx.store, 'INV/2026-27/002');
    assert.deepEqual([row.reminder_count, row.last_reminded], [2, '2026-10-23']);
    assert.match(r.message, /INV\/2026-27\/002/);
  });
  assert.match((await call(ctx.db, 'log_reminder', { client: 'Edustudy' })).error, /Nothing is owed/);
  assert.match((await call(ctx.db, 'log_reminder', {})).error, /Say which/);
});

test('business details: edit them, and refuse bad values', async t => {
  const ctx = setup(t);
  await changeAndUndo(t, ctx, 'update_settings', { upi_id: 'new@ybl', payment_terms_days: 15, invoice_prefix: 'MEC' }, r => {
    assert.deepEqual([r.settings.upiId, r.settings.paymentTermsDays, r.settings.invoicePrefix], ['new@ybl', 15, 'MEC']);
  });
  await assert.rejects(call(ctx.db, 'update_settings', { upi_id: 'not a upi id' }), /UPI ID/);
  await assert.rejects(call(ctx.db, 'update_settings', { invoice_prefix: 'INV/2' }), /prefix/);
  await assert.rejects(call(ctx.db, 'update_settings', { payment_terms_days: 2.5 }), /whole number/);
  await assert.rejects(call(ctx.db, 'update_settings', {}), /Say what to change/);
});

test('business details are added the first time they are saved', async t => {
  const fresh = setup(t, { empty: true });
  assert.deepEqual(await call(fresh.db, 'get_settings'), { settings: { businessName: '', address: '', phone: '', email: '', upiId: '', bankDetails: '', invoicePrefix: 'INV', paymentTermsDays: 7, invoiceNotes: '',
    defaultCurrency: 'INR', fyStartMonth: 4, timezone: 'Asia/Kolkata', locale: 'en-IN' }, saved: false }); // a new user gets the old behaviour
  await changeAndUndo(t, fresh, 'update_settings', { business_name: 'Mec' }, () => {
    assert.deepEqual(rows(fresh.store, 'settings').map(x => [x.business_name, x.invoice_prefix, x.payment_terms_days]), [['Mec', 'INV', 7]]);
  });
});

test('invoices stay right when projects, milestones and clients change', async t => {
  const ctx = setup(t);
  await changeAndUndo(t, ctx, 'delete_project', { project: 'GeekBoz Website', confirm: true }, () => {
    assert.deepEqual([inv(ctx.store, 'INV/2026-27/002').project_id, inv(ctx.store, 'INV/2026-27/002').milestone_id], [null, null]); // the invoice stays with the client
  });
  await changeAndUndo(t, ctx, 'set_milestones', { project: 'GeekBoz Website', split: [50, 50] }, () => {
    assert.equal(inv(ctx.store, 'INV/2026-27/002').milestone_id, null);
  });
  const preview = await call(ctx.db, 'delete_client', { client: 'GeekBoz' });
  assert.deepEqual(preview.invoices, ['INV/2026-27/001', 'INV/2026-27/002']);
  await changeAndUndo(t, ctx, 'delete_client', { client: 'GeekBoz', confirm: true }, () => {
    assert.ok(!rows(ctx.store, 'invoices', OWNER).some(i => i.client_id === ids.geekboz));
  });
  // Undoing a new invoice is refused once a payment is linked to it.
  const made = await call(ctx.db, 'create_invoice', { client: 'Edustudy', items: [{ description: 'X', rate: 100 }], mark_sent: true });
  await call(ctx.db, 'add_payment', { amount: 100, invoice: made.invoice.number });
  assert.match((await call(ctx.db, 'undo_change', { change_id: made.change_id })).error, /newer item/);
});

const svcRow = (store, id) => store.rows.services.find(x => x.id === id);

test('renew a service: preview first, then expense, draft invoice and next date in one change that one undo reverses', async t => {
  const ctx = setup(t);
  const before = ctx.store.snapshot();
  const preview = await call(ctx.db, 'renew_service', { service: 'Hostinger Business' });
  assert.equal(preview.confirmation_required, true);
  assert.deepEqual(preview.steps, ['Log ₹3,000 spent on Hostinger Business (Hosting).', 'Create draft invoice INV/2026-27/004 to GeekBoz for ₹6,000.', 'Move the next renewal from 20 Oct 2026 to 20 Oct 2027.']);
  assert.deepEqual(ctx.store.snapshot(), before);
  await changeAndUndo(t, ctx, 'renew_service', { service: 'Hostinger Business', confirm: true }, r => {
    assert.deepEqual([r.invoice, r.nextRenewal], ['INV/2026-27/004', '2027-10-20']);
    assert.equal(svcRow(ctx.store, ids.svcHosting).next_renewal, '2027-10-20');
    const out = rows(ctx.store, 'txns').find(x => x.note === 'Hostinger Business renewal');
    assert.deepEqual([out.type, Number(out.amount), out.category, out.client_id, out.project_id, out.date], ['out', 3000, 'Hosting', ids.geekboz, ids.gbSite, '2026-10-23']);
    const inv = ctx.store.rows.invoices.find(i => i.number === 'INV/2026-27/004');
    assert.deepEqual([Number(inv.total), inv.status, inv.client_id, inv.project_id, inv.due_date], [6000, 'draft', ids.geekboz, ids.gbSite, '2026-10-30']);
    assert.deepEqual(inv.items, [{ description: 'Hostinger Business — hosting renewal (20 Oct 2026 to 19 Oct 2027)', quantity: 1, rate: 6000 }]);
  });
  // Undo removed all three: the snapshot check in changeAndUndo proves it.
});

test('renew without the expense or invoice, a monthly plan from 31 Jan, and an inactive service', async t => {
  const ctx = setup(t);
  await changeAndUndo(t, ctx, 'renew_service', { service: 'geekboz.in', create_invoice: false, confirm: true }, r => {
    assert.equal(r.invoice, undefined);
    assert.equal(ctx.store.rows.invoices.filter(i => i.number === 'INV/2026-27/004').length, 0);
    assert.equal(rows(ctx.store, 'txns').find(x => x.note === 'geekboz.in renewal').category, 'Domain');
  });
  await call(ctx.db, 'update_service', { service: 'Monthly care plan', next_renewal: '2027-01-31' });
  const care = await call(ctx.db, 'renew_service', { service: 'Monthly care plan', confirm: true });
  assert.equal(care.nextRenewal, '2027-02-28');
  assert.ok(!rows(ctx.store, 'txns').some(x => x.note === 'Monthly care plan renewal'), 'no expense when it costs you nothing');
  assert.match((await call(ctx.db, 'renew_service', { service: 'Google Workspace', confirm: true })).error, /inactive/);
});

test('add and edit services', async t => {
  const ctx = setup(t);
  await changeAndUndo(t, ctx, 'add_service', { client: 'Edustudy', project: 'Edustudy Website', name: 'edustudy.in', kind: 'domain', cost: 900, price: 1800, next_renewal: '2027-03-01' }, r => {
    const x = rows(ctx.store, 'services').find(x => x.name === 'edustudy.in');
    assert.deepEqual([x.client_id, x.project_id, x.cycle, x.active, x.auto_renew], [ids.edustudy, ids.eduSite, 'yearly', true, false]);
    assert.equal(r.service.yearlyProfit, 900);
  });
  await changeAndUndo(t, ctx, 'add_service', { project: 'GeekBoz Website', name: 'SSL', kind: 'ssl', price: 500, cycle: 'yearly', next_renewal: '2027-01-01' }, () => {
    assert.equal(rows(ctx.store, 'services').find(x => x.name === 'SSL').client_id, ids.geekboz);
  });
  await changeAndUndo(t, ctx, 'update_service', { service: 'geekboz.in', client: 'GeekBoz', price: 2000, active: false, project: '' }, () => {
    const x = svcRow(ctx.store, ids.svcDomain);
    assert.deepEqual([Number(x.price), x.active, x.project_id], [2000, false, null]);
  });
  const add = a => call(ctx.db, 'add_service', { client: 'GeekBoz', name: 'X', next_renewal: '2027-01-01', ...a });
  await assert.rejects(add({ kind: 'car' }), /kind must be/);
  await assert.rejects(add({ cycle: 'weekly' }), /cycle must be/);
  await assert.rejects(add({ cost: -5 }), /Cost/);
  await assert.rejects(add({ next_renewal: undefined }), /next renews/);
  await assert.rejects(add({ project: 'Edustudy Website' }), /different client/);
  await assert.rejects(call(ctx.db, 'update_service', { service: 'geekboz.in' }), /Say what to change/);
});

test('services go with their client, and stay with the client when their project is deleted', async t => {
  const ctx = setup(t);
  const preview = await call(ctx.db, 'delete_client', { client: 'GeekBoz' });
  assert.deepEqual(preview.services, ['geekboz.in', 'Hostinger Business']);
  await changeAndUndo(t, ctx, 'delete_client', { client: 'GeekBoz', confirm: true }, () => {
    assert.ok(!rows(ctx.store, 'services').some(x => x.client_id === ids.geekboz && x.user_id !== require('./helpers/seed').OTHER));
  });
  await changeAndUndo(t, ctx, 'delete_project', { project: 'GeekBoz Website', confirm: true }, () => {
    assert.deepEqual([svcRow(ctx.store, ids.svcDomain).project_id, svcRow(ctx.store, ids.svcDomain).client_id], [null, ids.geekboz]);
  });
});

test('log payments and expenses', async t => {
  const ctx = setup(t);
  await changeAndUndo(t, ctx, 'add_payment', { amount: '₹5,000', project: 'GeekBoz Website', note: 'Second payment' }, r => {
    assert.match(r.message, /₹5,000 in/);
    const x = rows(ctx.store, 'txns').find(x => x.note === 'Second payment');
    assert.deepEqual([x.type, Number(x.amount), x.date, x.client_id, x.category], ['in', 5000, '2026-10-23', ids.geekboz, '']);
  });
  await changeAndUndo(t, ctx, 'add_expense', { amount: 899, client: 'Edustudy', note: 'Hosting' }, () => {
    const x = rows(ctx.store, 'txns').find(x => Number(x.amount) === 899);
    assert.deepEqual([x.type, x.category, x.project_id], ['out', 'Hosting', null]);
  });
  await assert.rejects(call(ctx.db, 'add_payment', { amount: 0, client: 'GeekBoz' }), /above 0/);
  await assert.rejects(call(ctx.db, 'add_payment', { amount: 100, client: 'GeekBoz', date: '23-10-2026' }), /YYYY-MM-DD/);
  assert.match((await call(ctx.db, 'add_payment', { amount: 100 })).error, /Say which client/);
  assert.match((await call(ctx.db, 'add_payment', { amount: 100, project: 'Website' })).error, /Several projects/);
});

test('bulk add saves all or nothing', async t => {
  const ctx = setup(t);
  const before = ctx.store.snapshot();
  const bad = await call(ctx.db, 'add_transactions', { entries: [
    { type: 'in', amount: 1000, client: 'GeekBoz' },
    { type: 'out', amount: 200, client: 'Nobody' }
  ] });
  assert.match(bad.error, /Nothing was saved. Entry 2/);
  assert.deepEqual(ctx.store.snapshot(), before);
  await changeAndUndo(t, ctx, 'add_transactions', { entries: [
    { type: 'in', amount: 1000, client: 'GeekBoz', date: '2026-10-01' },
    { type: 'out', amount: 200, project: 'App', category: 'software & plugins' },
    { type: 'out', amount: 300, client: 'Edustudy', note: 'domain' }
  ] }, r => {
    assert.equal(r.entries.length, 3);
    assert.deepEqual(r.entries.map(e => e.category), [null, 'Software & plugins', 'Domain']);
  });
  await assert.rejects(call(ctx.db, 'add_transactions', { entries: [{ type: 'out', amount: 5, client: 'GeekBoz', category: 'Food' }] }), /Category must be/);
});

test('edit and delete money entries', async t => {
  const ctx = setup(t);
  await changeAndUndo(t, ctx, 'update_transaction', { id: ids.advance, amount: 25000, date: '' }, () => {
    const x = rows(ctx.store, 'txns').find(x => x.id === ids.advance);
    assert.deepEqual([Number(x.amount), x.date], [25000, null]);
  });
  await changeAndUndo(t, ctx, 'update_transaction', { id: ids.advance, project: '', client: 'Edustudy' }, () => {
    const x = rows(ctx.store, 'txns').find(x => x.id === ids.advance);
    assert.deepEqual([x.project_id, x.client_id], [null, ids.edustudy]);
  });
  await changeAndUndo(t, ctx, 'update_transaction', { id: ids.domain, type: 'in' }, () => {
    assert.equal(rows(ctx.store, 'txns').find(x => x.id === ids.domain).category, '');
  });
  assert.match((await call(ctx.db, 'update_transaction', { id: ids.otherTxn, amount: 1 })).error, /No money entry/);
  const preview = await call(ctx.db, 'delete_transactions', { ids: [ids.advance, ids.domain] });
  assert.equal(preview.entries.length, 2);
  await changeAndUndo(t, ctx, 'delete_transactions', { ids: [ids.advance, ids.domain], confirm: true });
  assert.match((await call(ctx.db, 'delete_transactions', { ids: [ids.otherTxn], confirm: true })).error, /No money entry/);
});

test('undo: latest by default, once only, and not when something newer depends on it', async t => {
  const ctx = setup(t);
  const start = ctx.store.snapshot();
  const a = await call(ctx.db, 'create_project', { title: 'Shop', client: 'GeekBoz' });
  const b = await call(ctx.db, 'add_payment', { amount: 100, project: 'Shop' });
  const blocked = await call(ctx.db, 'undo_change', { change_id: a.change_id });
  assert.match(blocked.error, /newer item/);
  const latest = await call(ctx.db, 'undo_change', {});
  assert.equal(latest.change_id, b.change_id);
  assert.match((await call(ctx.db, 'undo_change', { change_id: b.change_id })).error, /already undone/);
  assert.equal((await call(ctx.db, 'undo_change', {})).change_id, a.change_id);
  assert.deepEqual(ctx.store.snapshot(), start);
  assert.match((await call(ctx.db, 'undo_change', {})).error, /no changes left/);
  const list = await call(ctx.db, 'list_recent_changes', {});
  assert.deepEqual(list.changes.map(c => c.undone), [true, true]);
});

test('changes are refused when the activity log table is missing', async t => {
  const ctx = setup(t, { missing: ['activity_log'] });
  const before = ctx.store.snapshot();
  await assert.rejects(call(ctx.db, 'create_client', { name: 'New' }), /activity_log table is missing/);
  await assert.rejects(call(ctx.db, 'add_payment', { amount: 5, client: 'GeekBoz' }), /activity_log/);
  assert.deepEqual(ctx.store.snapshot(), before);
});

test('one user can\'t see or change another user\'s data by id or name', async t => {
  const ctx = setup(t);
  const other = theirs(ctx.store);
  assert.match((await call(ctx.db, 'update_project', { project: ids.otherProject, status: 'done' })).error, /No project matches/);
  assert.match((await call(ctx.db, 'delete_client', { client: ids.otherClient, confirm: true })).error, /No client matches/);
  await call(ctx.db, 'delete_client', { client: 'GeekBoz', confirm: true }); // same name as the other user's client
  assert.equal(theirs(ctx.store), other);
  const theirChanges = await call(ctx.otherDb, 'list_recent_changes', {});
  assert.equal(theirChanges.count, 0);
  assert.match((await call(ctx.otherDb, 'undo_change', {})).error, /no changes left/);
});
