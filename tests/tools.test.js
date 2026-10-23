// The tool list Claude sees: well-formed, and every read tool runs on real-looking data.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers/setup');
const { TOOLS, INSTRUCTIONS } = require('../api/_lib/tools');

const ANNOTATION_KEYS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];

function checkSchema(s, where) {
  assert.ok(s && typeof s === 'object', where);
  if (s.type === 'object') {
    assert.equal(s.additionalProperties, false, where + ' should not allow unknown fields');
    for (const r of s.required || []) assert.ok(s.properties[r], where + ' requires ' + r + ' but doesn\'t define it');
    for (const [k, v] of Object.entries(s.properties || {})) checkSchema(v, where + '.' + k);
  } else if (s.type === 'array') checkSchema(s.items, where + '[]');
  else assert.ok(['string', 'number', 'integer', 'boolean'].includes(s.type), where + ' has type ' + s.type);
  if (s.enum) assert.ok(Array.isArray(s.enum) && s.enum.length, where);
}

test('every tool is well formed', () => {
  const names = TOOLS.map(t => t.name);
  assert.equal(new Set(names).size, names.length, 'tool names must be unique');
  for (const t of TOOLS) {
    assert.match(t.name, /^[a-z][a-z_]{2,63}$/);
    assert.ok(t.title && t.description && t.description.length > 20, t.name + ' needs a title and a useful description');
    assert.equal(typeof t.run, 'function', t.name);
    assert.equal(t.inputSchema.type, 'object', t.name);
    checkSchema(t.inputSchema, t.name);
    assert.ok(t.annotations && Object.keys(t.annotations).every(k => ANNOTATION_KEYS.includes(k)), t.name + ' annotations');
    assert.equal(typeof t.annotations.readOnlyHint, 'boolean', t.name);
  }
  assert.doesNotThrow(() => JSON.stringify(TOOLS.map(({ run, ...t }) => t)));
});

test('read-only tools never change anything, and change tools say so', () => {
  for (const t of TOOLS) {
    if (/^(get|list|search|compare)_?/.test(t.name)) assert.equal(t.annotations.readOnlyHint, true, t.name + ' reads, so it should be read-only');
    if (/^delete|undo/.test(t.name)) assert.equal(t.annotations.destructiveHint, true, t.name);
    if (/^delete/.test(t.name)) assert.ok(t.inputSchema.properties.confirm, t.name + ' must be two-step with confirm');
  }
});

test('every read tool runs on the seed ledger without errors and changes nothing', async t => {
  const { db, store } = setup(t);
  const before = JSON.stringify(store.rows);
  const args = { search: { query: 'web' }, get_project: { project: 'GeekBoz Website' }, get_client: { client: 'Edustudy' }, get_invoice: { invoice: '002' }, draft_payment_reminder: { client: 'GeekBoz' } };
  for (const tool of TOOLS.filter(x => x.annotations.readOnlyHint)) {
    const r = await tool.run(db, args[tool.name] || {});
    assert.ok(r && typeof r === 'object', tool.name);
    assert.equal(r.error, undefined, tool.name + ': ' + r.error);
  }
  for (const period of TOOLS.find(x => x.name === 'get_summary').inputSchema.properties.period.enum) {
    assert.equal(typeof (await TOOLS.find(x => x.name === 'get_summary').run(db, { period })).revenue, 'number', period);
  }
  assert.equal(JSON.stringify(store.rows), before);
});

test('read tools work on an empty ledger', async t => {
  const { db } = setup(t, { empty: true });
  for (const tool of TOOLS.filter(x => x.annotations.readOnlyHint && !['get_project', 'get_client', 'search', 'get_invoice', 'draft_payment_reminder'].includes(x.name))) {
    const r = await tool.run(db, {});
    assert.equal(r.error, undefined, tool.name);
  }
});

test('the instructions mention the rules Claude must follow', () => {
  for (const rule of [/rupees|INR/, /confirm: true/, /new_client: true/, /undo_change/]) assert.match(INSTRUCTIONS, rule);
});
