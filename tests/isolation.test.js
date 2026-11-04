// One person can never see or change another person's ledger (family plan, step 5).
// Every Claude tool is run as the owner, aimed at the OTHER user's ids, and must neither show their data nor change it.
// The tool list and the table list come from the code and the schema, so a tool or table added later is covered too.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers/setup');
const { ids, OWNER, OTHER } = require('./helpers/seed');
const { parse } = require('./helpers/schema');
const { TOOLS } = require('../api/_lib/tools');

const schema = parse();
const ledgerTables = Object.keys(schema).filter(t => t !== 'allowed_emails'); // the invite list has no owner (and no id)
const theirs = store => Object.fromEntries(ledgerTables.map(t => [t, JSON.stringify(store.rows[t].filter(r => r.user_id === OTHER))]));
const theirIds = store => ledgerTables.flatMap(t => store.rows[t].filter(r => r.user_id === OTHER).map(r => r.id)).filter(Boolean);
// Things only the OTHER user's rows contain (amounts, notes, details), which no answer to the owner may include.
// Amounts count only as whole numbers, not as part of an id like 99999999-0000-….
const MARKERS = [/(?<![\w-])99,?999(?![\w-])/, /(?<![\w-])77,?777(?![\w-])/, /other@ybl/, /not yours/i, /Theirs/];

// What to aim at their data, for each kind of input a tool can take.
const AIM = {
  client: [ids.otherClient], move_to_client: [ids.otherClient], project: [ids.otherProject],
  id: [ids.otherTxn], ids: [[ids.otherTxn]], invoice: [ids.otherInv], milestone: [ids.otherMs],
  service: [ids.otherSvc], task: [ids.otherTask, 'Theirs'],
  entries: [[{ type: 'in', amount: 5, client: ids.otherClient, project: ids.otherProject }], [{ type: 'out', amount: 5, client: 'GeekBoz', project: ids.otherProject }]],
  query: ['Theirs', 'Not yours', '99999', 'other@ybl'], search: ['Theirs', 'Not yours']
};
// Plain values for the other inputs a tool needs, so the call gets as far as looking their row up.
const FILL = { title: 'Probe', name: 'Probe', amount: 5, next_renewal: '2026-12-01', tasks: [{ title: 'Probe' }], minutes: 30, hours: 1,
  items: [{ description: 'Probe', quantity: 1, rate: 5 }], confirm: true, done: true, status: 'done', note: 'Probe', notes: 'Probe' };

async function run(db, tool, args) {
  try { return await tool.run(db, args); } catch (e) { return { thrown: e.message }; }
}

for (const tool of TOOLS) {
  test(tool.name + ': aimed at another person\'s data, shows none of it and changes none of it', async t => {
    const ctx = setup(t);
    const props = Object.keys(tool.inputSchema.properties || {});
    const base = Object.fromEntries(props.filter(p => p in FILL).map(p => [p, FILL[p]]));
    const tries = [base]; // with no aim at all, a list or summary must still only be the owner's
    for (const p of props) for (const v of AIM[p] || []) tries.push({ ...base, [p]: v });
    const before = theirs(ctx.store), hidden = theirIds(ctx.store);
    for (const args of tries) {
      const r = await run(ctx.db, tool, args);
      const out = JSON.stringify(r), asked = JSON.stringify(args);
      for (const m of MARKERS) if (!m.test(asked)) assert.ok(!m.test(out), tool.name + ' ' + asked + ' showed ' + m + ': ' + out.slice(0, 300));
      for (const id of hidden) if (!asked.includes(id)) assert.ok(!out.includes(id), tool.name + ' ' + asked + ' showed their id ' + id);
      assert.deepEqual(theirs(ctx.store), before, tool.name + ' ' + asked + ' changed the other person\'s rows');
      // nothing of the owner's now points at the other person's rows
      for (const tb of ledgerTables) for (const row of ctx.store.rows[tb].filter(x => x.user_id === OWNER)) {
        for (const [col, v] of Object.entries(row)) if (col !== 'id' && hidden.includes(v)) assert.fail(tool.name + ' ' + asked + ' made ' + tb + '.' + col + ' point at their row');
      }
    }
  });
}

test('every tool is covered: each id-like input is aimed at the other person', () => {
  const refs = new Set(TOOLS.flatMap(t => Object.keys(t.inputSchema.properties || {})).filter(p => /^(id|ids|client|project|invoice|milestone|service|task|entries|move_to_client|change_id)$/.test(p)));
  for (const p of refs) if (p !== 'change_id') assert.ok(AIM[p], 'no aim for the input "' + p + '": add one to AIM so a new tool taking it is tested');
});

test('undo_change cannot undo the other person\'s change', async t => {
  const ctx = setup(t);
  const theirChange = await TOOLS.find(x => x.name === 'create_client').run(ctx.otherDb, { name: 'Their new client' });
  assert.equal(theirChange.done, true);
  const before = theirs(ctx.store);
  const undo = TOOLS.find(x => x.name === 'undo_change');
  const r = await run(ctx.db, undo, { change_id: theirChange.change_id });
  assert.ok(r.error || r.thrown, 'the owner must not be able to undo it: ' + JSON.stringify(r));
  assert.deepEqual(theirs(ctx.store), before);
  const recent = JSON.stringify(await TOOLS.find(x => x.name === 'list_recent_changes').run(ctx.db, {}));
  assert.ok(!recent.includes(theirChange.change_id) && !recent.includes('Their new client'), 'their changes don\'t show in the owner\'s history');
  // and their own undo still works
  assert.equal((await undo.run(ctx.otherDb, { change_id: theirChange.change_id })).done, true);
});

test('every table: the server\'s database access never reads or changes the other person\'s rows', async t => {
  const ctx = setup(t);
  await TOOLS.find(x => x.name === 'create_client').run(ctx.otherDb, { name: 'Their new client' }); // gives them change history too
  for (const tb of ledgerTables) {
    const mine = await ctx.db.select(tb);
    assert.ok(mine.every(r => r.user_id === OWNER), tb + ' select returned someone else\'s row');
    const their = ctx.store.rows[tb].filter(r => r.user_id === OTHER);
    assert.ok(their.length, tb + ': the seed should give the other user a row here, so this table is really tested');
    const before = JSON.stringify(their);
    for (const r of their) {
      if (!r.id) continue;
      assert.deepEqual(await ctx.db.update(tb, r.id, {}).catch(() => []), [], tb + ' update reached their row');
      assert.deepEqual(await ctx.db.remove(tb, r.id).catch(() => []), [], tb + ' delete reached their row');
    }
    assert.equal(JSON.stringify(ctx.store.rows[tb].filter(r => r.user_id === OTHER)), before, tb + ' changed');
  }
});
