// Every change tool: what it saves, what it refuses, and that undo_change puts the data back exactly.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers/setup');
const { ids, OTHER } = require('./helpers/seed');
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
  assert.equal(preview.confirmation_required, true);
  await changeAndUndo(t, ctx, 'delete_project', { project: 'GeekBoz Website', confirm: true }, () => {
    assert.deepEqual(rows(ctx.store, 'txns').filter(x => [ids.advance, ids.domain].includes(x.id)).map(x => x.project_id), [null, null]);
  });
  await changeAndUndo(t, ctx, 'delete_project', { project: 'GeekBoz Website', delete_transactions: true, confirm: true }, () => {
    assert.ok(!rows(ctx.store, 'txns').some(x => x.id === ids.advance));
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
