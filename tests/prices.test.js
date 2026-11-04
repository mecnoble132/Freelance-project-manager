// A project's price and its milestones: milestones on a project with no price set its price, and money received
// can be over 100% of the price.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers/setup');
const { ids, OWNER, OTHER } = require('./helpers/seed');
const { TOOLS } = require('../api/_lib/tools');

const call = (db, name, args = {}) => TOOLS.find(x => x.name === name).run(db, args);
const theirs = store => JSON.stringify(Object.values(store.rows).flat().filter(r => r.user_id === OTHER));
const project = (store, id) => store.rows.projects.find(p => p.id === id);
async function changeAndUndo(ctx, name, args, check) {
  const before = ctx.store.snapshot(), other = theirs(ctx.store);
  const r = await call(ctx.db, name, args);
  assert.equal(r.done, true, JSON.stringify(r));
  if (check) await check(r);
  assert.equal((await call(ctx.db, 'undo_change', { change_id: r.change_id })).done, true);
  assert.deepEqual(ctx.store.snapshot(), before, 'undo of ' + name + ' left the data different');
  assert.equal(theirs(ctx.store), other);
}

test('milestones on a project with no price make their total its price, in the same change', async t => {
  const ctx = setup(t);
  ctx.store.update('projects', p => p.id === ids.gbSite, { quoted: 0 });
  await changeAndUndo(ctx, 'set_milestones', { project: 'GeekBoz Website', milestones: [{ name: 'Advance', amount: 3000 }, { name: 'Balance', amount: 2000 }] }, r => {
    assert.equal(Number(project(ctx.store, ids.gbSite).quoted), 5000);
    assert.equal(r.quoted, 5000);
    assert.match(r.message || r.summary || JSON.stringify(r), /It had no price, so its price is now ₹5,000/);
  });
});

test('milestones on a project that has a price leave the price alone', async t => {
  const ctx = setup(t);
  await changeAndUndo(ctx, 'set_milestones', { project: 'GeekBoz Website', milestones: [{ amount: 10000 }] }, r => {
    assert.equal(Number(project(ctx.store, ids.gbSite).quoted), 50000);
    assert.equal(r.quoted, undefined);
    assert.match(r.warning, /add up to ₹10,000, but the quote is ₹50,000/);
  });
});

test('paid percentage goes over 100 when more came in than was agreed', async t => {
  const ctx = setup(t);
  await call(ctx.db, 'add_payment', { amount: 40000, client: 'GeekBoz', project: 'Website' }); // 20,000 + 40,000 of 50,000
  const p = await call(ctx.db, 'get_project', { project: 'GeekBoz Website' });
  assert.equal(p.money.percentPaid, 120);
  assert.equal(p.money.stillToCollect, 0);
});
