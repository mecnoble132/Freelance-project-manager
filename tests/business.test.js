// Kinds of business on the MCP side (family plan, step 4): the owner is web development, a family member makes gift boxes.
// The web development case is covered by every older test, which is unchanged; these cover the setting and the other kinds.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers/setup');
const { ids, OWNER, OTHER } = require('./helpers/seed');
const { TOOLS, INSTRUCTIONS, instructionsFor } = require('../api/_lib/tools');
const L = require('../api/_lib/ledger');

const call = (db, name, args = {}) => TOOLS.find(x => x.name === name).run(db, args);
const theirs = store => JSON.stringify(Object.values(store.rows).flat().filter(r => r.user_id === OTHER));
const mine = (store, table) => store.rows[table].filter(r => r.user_id === OWNER);
// Same helper as writes.test.js: run a change, check it, undo it, and check every table is exactly as before.
async function changeAndUndo(ctx, name, args, check) {
  const before = ctx.store.snapshot(), other = theirs(ctx.store);
  const r = await call(ctx.db, name, args);
  assert.equal(r.done, true, JSON.stringify(r));
  if (check) await check(r);
  const u = await call(ctx.db, 'undo_change', { change_id: r.change_id });
  assert.equal(u.done, true, JSON.stringify(u));
  assert.deepEqual(ctx.store.snapshot(), before, 'undo of ' + name + ' left the data different');
  assert.equal(theirs(ctx.store), other);
  return r;
}
// The owner's ledger, with the owner switched to another kind of business.
function as(t, kind) {
  const ctx = setup(t);
  ctx.store.update('settings', r => r.user_id === OWNER, { business_type: kind });
  return ctx;
}

test('the kinds of business: web development is the old lists, and every kind is complete', () => {
  assert.deepEqual(Object.keys(L.BUSINESS_TYPES), ['web_dev', 'products', 'general']);
  assert.deepEqual(L.BUSINESS_TYPES.web_dev.categories, L.CATEGORIES);
  assert.deepEqual(L.BUSINESS_TYPES.web_dev.statuses, L.STATUS_LABELS);
  for (const [k, b] of Object.entries(L.BUSINESS_TYPES)) {
    assert.deepEqual(Object.keys(b.statuses), L.STATUSES, k + ' must label every status');
    assert.ok(b.categories.includes('Other'), k + ' needs an Other category (the fallback for a note that matches nothing)');
    assert.equal(b.project.length, 2); assert.equal(b.client.length, 2);
    assert.deepEqual(Object.keys(b.dates), ['start', 'due', 'quoted']);
    for (const c of b.categories) assert.ok(L.ALL_CATEGORIES.includes(c));
  }
  assert.equal(L.businessType('nonsense'), 'web_dev');
  assert.equal(L.businessType(undefined), 'web_dev');
});

test('business_type: shown, saved by key or by name, refused when unknown, and undone', async t => {
  const ctx = setup(t);
  assert.equal((await call(ctx.db, 'get_settings')).settings.businessType, 'web_dev');
  await changeAndUndo(ctx, 'update_settings', { business_type: 'products' }, r => {
    assert.equal(r.settings.businessType, 'products');
    assert.equal(mine(ctx.store, 'settings')[0].business_type, 'products');
    assert.equal(mine(ctx.store, 'settings')[0].business_name, 'Mec Web Studio', 'nothing else changes');
  });
  await changeAndUndo(ctx, 'update_settings', { business_type: 'Other services' }, r => assert.equal(r.settings.businessType, 'general'));
  await assert.rejects(call(ctx.db, 'update_settings', { business_type: 'bakery' }), /business_type must be one of: web_dev \(web development\), products \(products made to order\), general \(other services\)/);
  assert.equal(ctx.store.rows.settings.find(r => r.user_id === OTHER).business_type, 'web_dev', 'the other user\'s settings are untouched');
  assert.deepEqual(TOOLS.find(x => x.name === 'update_settings').inputSchema.properties.business_type.enum, Object.keys(L.BUSINESS_TYPES));
});

test('a brand-new user is web development until they choose', async t => {
  const ctx = setup(t, { empty: true });
  assert.equal((await L.load(ctx.db)).settings.businessType, 'web_dev');
  await call(ctx.db, 'update_settings', { business_type: 'products' });
  assert.equal((await L.load(ctx.db)).settings.businessType, 'products');
});

test('a gift-box business is held to its own expense categories', async t => {
  const ctx = as(t, 'products');
  const ok = await call(ctx.db, 'add_expense', { amount: 450, client: 'GeekBoz', project: 'Website', note: 'Ribbons', category: 'materials & packaging' });
  assert.equal(ok.done, true, JSON.stringify(ok));
  assert.equal(mine(ctx.store, 'txns').find(x => x.note === 'Ribbons').category, 'Materials & packaging');
  await assert.rejects(call(ctx.db, 'add_expense', { amount: 100, client: 'GeekBoz', category: 'Hosting' }),
    /Category must be one of: Materials & packaging, Products & stock, Printing & labels, Shipping & delivery, Platform & payment fees, Ads & marketing, Travel, Other\./);
  // no category: the note picks one of theirs, else Other
  await call(ctx.db, 'add_expense', { amount: 90, client: 'GeekBoz', note: 'Shipping & delivery' });
  await call(ctx.db, 'add_expense', { amount: 80, client: 'GeekBoz', note: 'Domain' });
  assert.equal(mine(ctx.store, 'txns').find(x => x.amount === 90).category, 'Shipping & delivery');
  assert.equal(mine(ctx.store, 'txns').find(x => x.amount === 80).category, 'Other', 'a web category in a note isn\'t theirs');
  // the schema offers every kind's categories, and says which are whose
  const cat = TOOLS.find(x => x.name === 'add_expense').inputSchema.properties.category;
  assert.deepEqual(cat.enum, L.ALL_CATEGORIES);
  assert.match(cat.description, /products made to order: Materials & packaging/);
});

test('an older entry keeps a category from before the kind of business changed, but cannot take a new one', async t => {
  const ctx = as(t, 'products');
  const r = await changeAndUndo(ctx, 'update_transaction', { id: ids.domain, amount: 1200 }, () => {
    assert.equal(mine(ctx.store, 'txns').find(x => x.id === ids.domain).category, 'Domain');
  });
  assert.equal(r.done, true);
  await changeAndUndo(ctx, 'update_transaction', { id: ids.domain, category: 'Domain', note: 'Old .com' });
  await assert.rejects(call(ctx.db, 'update_transaction', { id: ids.domain, category: 'Hosting' }), /Category must be one of: Materials/);
  await changeAndUndo(ctx, 'update_transaction', { id: ids.domain, category: 'Printing & labels' }, () => {
    assert.equal(mine(ctx.store, 'txns').find(x => x.id === ids.domain).category, 'Printing & labels');
  });
});

test('the web development owner still uses the web categories', async t => {
  const ctx = setup(t);
  await assert.rejects(call(ctx.db, 'add_expense', { amount: 100, client: 'GeekBoz', category: 'Materials & packaging' }), /Category must be one of: Domain, Hosting/);
});

test('statuses read in the user\'s words, and their words work as input', async t => {
  const ctx = as(t, 'products');
  const list = await call(ctx.db, 'list_projects');
  assert.deepEqual(list.projects.map(p => p.status).sort(), ['Delivered', 'Enquiry', 'Making']);
  assert.deepEqual((await call(ctx.db, 'list_projects', { status: 'making' })).projects.map(p => p.title), ['Website']);
  await changeAndUndo(ctx, 'update_project', { project: 'GeekBoz Website', status: 'Delivered' }, () => {
    assert.equal(mine(ctx.store, 'projects').find(p => p.id === ids.gbSite).status, 'done');
  });
  await changeAndUndo(ctx, 'update_project', { project: 'GeekBoz Website', status: 'enquiry' }, () => {
    assert.equal(mine(ctx.store, 'projects').find(p => p.id === ids.gbSite).status, 'lead');
  });
  assert.deepEqual((await call(ctx.db, 'get_summary')).projectsByStatus, { Making: 1, Delivered: 1, Enquiry: 1 });
});

test('the web development owner still reads the old status labels', async t => {
  const ctx = setup(t);
  assert.deepEqual((await call(ctx.db, 'list_projects')).projects.map(p => p.status).sort(), ['Done', 'In progress', 'Lead']);
  assert.deepEqual((await call(ctx.db, 'get_summary')).projectsByStatus, { 'In progress': 1, Done: 1, Lead: 1 });
});

test('Claude is told about the user\'s kind of business; web development is the original text', () => {
  assert.equal(instructionsFor('web_dev'), INSTRUCTIONS);
  assert.equal(instructionsFor(undefined), INSTRUCTIONS);
  assert.equal(instructionsFor('nonsense'), INSTRUCTIONS);
  assert.match(INSTRUCTIONS, /^Client Ledger: a freelance web developer's clients, web projects/);
  const gifts = instructionsFor('products');
  assert.match(gifts, /makes and sells products to order \(like custom gift boxes\)/);
  assert.match(gifts, /calls a project an order and a client a customer/);
  assert.match(gifts, /lead = Enquiry, active = Making, paused = On hold, done = Delivered/);
  assert.match(gifts, /start_date is its order date, due_date its delivery date and quoted its price/);
  assert.match(gifts, /Expense categories: Materials & packaging, /);
  assert.doesNotMatch(gifts, /web developer|domains, hosting|"Website"/);
  for (const rule of [/confirm: true/, /new_client: true/, /undo_change/, /otherCurrencies/]) assert.match(gifts, rule, 'the shared rules are still there');
  const general = instructionsFor('general');
  assert.match(general, /calls a project a job and a client a client/);
  assert.doesNotMatch(general + gifts, /rupees|India time|Indian financial|April to March/i);
});
