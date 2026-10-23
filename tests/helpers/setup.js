// One call per test: a fresh fake Supabase with the seed ledger, frozen time, and the owner's database handle.
const fake = require('./fake-supabase');
const { seed, OWNER, OTHER, freezeTime } = require('./seed');
const { Store } = require('./store');
const { parse } = require('./schema');

fake.env();
const { forUser } = require('../../api/_lib/supabase');

function setup(t, { empty = false, missing = [], users = [] } = {}) {
  const store = new Store(parse(), { missing });
  if (!empty) seed(store);
  const f = fake.install({ store, users });
  t.after(f.restore);
  freezeTime(t);
  return { store, requests: f.requests, db: forUser(OWNER), otherDb: forUser(OTHER) };
}

module.exports = { setup };
