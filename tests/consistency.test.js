// Checks across files that repeat the same facts (statuses, categories, tables), and that schema.sql stays safe to
// run again and only ever adds things. These are the mistakes most likely when adding a feature.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parse, SQL } = require('./helpers/schema');
const ledger = require('../api/_lib/ledger');
const { TOOLS } = require('../api/_lib/tools');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const HTML = read('index.html'), WRITES = read('api/_lib/writes.js'), LEDGER = read('api/_lib/ledger.js');
const schema = parse();
// allowed_emails is the sign-up allow-list: owner-only, no user_id, not part of anyone's ledger (see its own test below).
const dataTables = Object.keys(schema).filter(t => t !== 'activity_log' && t !== 'allowed_emails');
const CURRENCY_TABLES = ['projects', 'txns', 'invoices', 'services'];
const arrayIn = (src, re) => { const m = re.exec(src); assert.ok(m, 'couldn\'t find ' + re); return JSON.parse('[' + m[1].replace(/'/g, '"') + ']'); };

test('project statuses match in every place they are listed', () => {
  const site = arrayIn(HTML, /const STATUSES = \[(.*?)\];\n/).map(x => x[0]);
  const tool = TOOLS.find(t => t.name === 'create_project').inputSchema.properties.status.enum;
  assert.deepEqual(site, ledger.STATUSES, 'index.html STATUSES vs ledger.js');
  assert.deepEqual(tool, ledger.STATUSES, 'tools.js statusIn vs ledger.js');
  assert.deepEqual(schema.projects.checks.status.values, ledger.STATUSES, 'schema.sql projects_status_check vs ledger.js');
  assert.ok(ledger.STATUSES.includes(schema.projects.columns.status.default.value));
});

test('expense categories match', () => {
  assert.deepEqual(arrayIn(HTML, /const CATEGORIES = \[(.*?)\];/), ledger.CATEGORIES);
});

test('every period on the website has a matching MCP period', () => {
  const site = [.../const PERIODS = \[(.*?)\];\n/.exec(HTML)[1].matchAll(/\['([a-z0-9_]+)'/g)].map(m => m[1]);
  const server = { month: 'this_month', '12m': 'last_12_months', this_fy: 'this_fy', last_fy: 'last_fy', year: 'this_year', all: 'all_time' };
  assert.deepEqual(site.slice().sort(), Object.keys(server).sort(), 'index.html PERIODS changed: update this map and ledger.js');
  for (const k of site) assert.ok(ledger.PERIODS.includes(server[k]), k + ' has no matching period in ledger.js');
  assert.match(HTML, /period:pref\('period','this_fy'\)/, 'the financial year should be the default period');
});

test('the website and the MCP server load the same tables, and they all exist', () => {
  const site = arrayIn(HTML, /const TABLES = \[(.*?)\];/);
  const server = arrayIn(LEDGER, /Promise\.all\(\[(.*?)\]\.map/);
  assert.deepEqual(site.slice().sort(), server.slice().sort());
  assert.deepEqual(site.slice().sort(), dataTables.slice().sort(), 'every table in schema.sql should be loaded (or this test updated)');
});

test('every table changed through the MCP server is in the activity_log list and in undo', () => {
  const written = new Set([...WRITES.matchAll(/ch\.(?:insert|update|remove)\('([a-z_]+)'/g)].map(m => m[1]));
  const logged = schema.activity_log.checks.table_name.values;
  for (const t of written) {
    assert.ok(schema[t], t + ' is written to but isn\'t in schema.sql');
    assert.ok(logged.includes(t), t + ' must be added to activity_log_table_name_check in schema.sql');
  }
  const current = /const current = \{([^}]*)\}/.exec(WRITES)[1].split(',').map(s => s.split(':')[0].trim());
  for (const t of dataTables) {
    assert.ok(logged.includes(t), t + ' must be added to activity_log_table_name_check');
    assert.ok(current.includes(t), t + ' must be added to the `current` map in undoChange');
  }
});

test('deleting a client or project handles every table that points at it', () => {
  const body = name => { const i = WRITES.indexOf('async function ' + name); return WRITES.slice(i, WRITES.indexOf('\n}\n', i)); };
  for (const [t, def] of Object.entries(schema)) {
    for (const [col, c] of Object.entries(def.columns)) {
      if (!c.references || t === 'activity_log') continue;
      const fn = c.references.table === 'clients' ? 'deleteClient' : c.references.table === 'projects' ? 'deleteProject' : null;
      if (!fn) continue;
      assert.match(body(fn), new RegExp('L\\.raw\\.' + t + '\\b'), fn + ' must deal with ' + t + '.' + col + ' (remove the rows with ch.remove first, so undo can bring them back)');
    }
  }
});

test('the website\'s local delete rules match the foreign keys in schema.sql', () => {
  const src = /const ON_DELETE = \{([\s\S]*?)\n\};/.exec(HTML)[1];
  const site = [];
  for (const [, parent, body] of src.matchAll(/([a-z_]+): \[((?:\['[a-z_]+','[a-z_]+','(?:cascade|null)'\],?)+)\]/g)) {
    for (const [, child, col, how] of body.matchAll(/\['([a-z_]+)','([a-z_]+)','(cascade|null)'\]/g)) site.push(parent + '<-' + child + '.' + col + ' ' + how);
  }
  const db = [];
  for (const [t, def] of Object.entries(schema)) for (const [col, c] of Object.entries(def.columns)) {
    if (!c.references || c.references.table === 'users' || t === 'activity_log' || c.references.table === 'auth') continue;
    db.push(c.references.table + '<-' + t + '.' + col + ' ' + (c.references.onDelete === 'set null' ? 'null' : c.references.onDelete));
  }
  assert.deepEqual(site.sort(), db.sort(), 'index.html ON_DELETE must list every foreign key in schema.sql with the same cascade / set null');
});

test('the website only reads columns that exist', () => {
  const map = /const map = \{([\s\S]*?)\n\};/.exec(HTML)[1];
  for (const [, table, body] of map.matchAll(/([a-z_]+): r => \(\{([\s\S]*?)\}\)/g)) {
    for (const [, col] of body.matchAll(/\br\.([a-z_]+)/g)) assert.ok(schema[table].columns[col], 'index.html reads ' + table + '.' + col + ', which isn\'t in schema.sql');
  }
});

test('schema.sql can be run again safely and only adds things', () => {
  const sql = SQL.replace(/--[^\n]*/g, '').replace(/\$\$[\s\S]*?\$\$/g, '$$$$');
  const statements = sql.split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const dropped = { policy: new Set(), constraint: new Set() };
  for (const s of statements) {
    assert.doesNotMatch(s, /\b(drop (table|column|index|schema|function)|rename|alter column|truncate|delete from|update public)\b/i, 'not additive: ' + s);
    if (/^create table/i.test(s)) assert.match(s, /^create table if not exists/i, s);
    if (/^create (unique )?index/i.test(s)) assert.match(s, /if not exists/i, s);
    if (/add column/i.test(s)) assert.match(s, /add column if not exists/i, s);
    let m;
    if ((m = /^drop trigger/i.exec(s))) assert.match(s, /^drop trigger if exists require_invited_email on auth\.users$/i, 'the sign-up gate is the only trigger that may be dropped and re-created: ' + s);
    if ((m = /^create trigger/i.exec(s))) assert.match(s, /^create trigger require_invited_email before insert on auth\.users for each row execute function public\.require_invited_email\(\)$/i, s);
    if ((m = /^drop policy if exists "([^"]+)" on (\S+)/i.exec(s))) dropped.policy.add(m[2] + ' ' + m[1]);
    if ((m = /^create policy "([^"]+)" on (\S+)/i.exec(s))) assert.ok(dropped.policy.has(m[2] + ' ' + m[1]), 'drop policy if exists must come before: ' + s);
    if ((m = /drop constraint if exists (\S+)/i.exec(s))) dropped.constraint.add(m[1]);
    if ((m = /add constraint (\S+)/i.exec(s))) assert.ok(dropped.constraint.has(m[1]), 'drop constraint if exists must come before: ' + s);
  }
});

test('every table has row-level security and an own-rows policy', () => {
  for (const t of Object.keys(schema).filter(t => t !== 'allowed_emails')) {
    assert.match(SQL, new RegExp('alter table public\\.' + t + ' enable row level security'), t + ' needs row level security');
    assert.match(SQL, new RegExp('create policy "[^"]+" on public\\.' + t + '\\s+for all to authenticated\\s+using \\(user_id = \\(select auth\\.uid\\(\\)\\)\\)\\s+with check \\(user_id = \\(select auth\\.uid\\(\\)\\)\\)'), t + ' needs an own-rows policy');
    assert.equal(schema[t].columns.user_id.default.fn, 'uid', t + '.user_id should default to auth.uid()');
    assert.match(SQL, new RegExp('create (unique )?index if not exists \\S+ on public\\.' + t + ' \\(user_id'), t + ' needs an index on user_id');
  }
});

test('only api/_lib/supabase.js talks to the database, and it exports nothing unscoped', () => {
  const files = [];
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') && files.push(path.join(d, e.name)));
  walk(path.join(root, 'api'));
  for (const f of files) {
    if (f.endsWith(path.join('_lib', 'supabase.js'))) continue;
    const src = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /SUPABASE_SERVICE_ROLE_KEY|\/rest\/v1|\/auth\/v1|\bfetch\(/, path.relative(root, f) + ' must go through api/_lib/supabase.js');
  }
  assert.deepEqual(Object.keys(require('../api/_lib/supabase')).sort(), ['DbError', 'UUID', 'forUser', 'signIn', 'userStillActive']);
  assert.doesNotMatch(read('config.js'), /sb_secret_/, 'config.js is public; never put the secret key there');
  const key = /supabaseAnonKey:\s*"([^"]+)"/.exec(read('config.js'));
  if (key && key[1].split('.').length === 3) assert.equal(JSON.parse(Buffer.from(key[1].split('.')[1], 'base64url')).role, 'anon', 'config.js must hold the anon key');
});

test('the currency list is the same on every table that carries money (and the default is INR)', () => {
  const list = ['INR', 'USD', 'EUR', 'GBP', 'AUD', 'CAD', 'SGD', 'AED', 'NZD', 'CHF', 'JPY', 'ZAR'];
  for (const t of CURRENCY_TABLES) {
    assert.deepEqual(schema[t].checks.currency.values, list, t + '.currency check');
    assert.equal(schema[t].columns.currency.default.value, 'INR', t + '.currency should default to INR so existing rows stay rupees');
    assert.ok(schema[t].columns.currency.notNull, t + '.currency should be not null');
  }
  assert.deepEqual(schema.settings.checks.default_currency.values, list);
  assert.ok(!schema.milestones.columns.currency, 'milestones use their project\'s currency; they don\'t store one');
  // TODO(step 2 / step 3): also compare with CURRENCIES in api/_lib/ledger.js and index.html.
});

test('regional settings default to what the app assumed before: rupees, April, India time', () => {
  const c = schema.settings.columns;
  assert.equal(c.default_currency.default.value, 'INR');
  assert.equal(c.fy_start_month.default.value, 4);
  assert.equal(c.timezone.default.value, 'Asia/Kolkata');
  assert.equal(c.locale.default.value, 'en-IN');
  assert.deepEqual(schema.settings.checks.fy_start_month.values, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.deepEqual(schema.settings.checks.locale.values, ['en-IN', 'en-US', 'en-GB', 'en-AU', 'en-CA']);
});

test('sample clients are flagged, and nobody is a sample by default', () => {
  assert.equal(schema.clients.columns.is_sample.default.value, false);
  assert.ok(schema.clients.columns.is_sample.notNull);
});

test('allowed_emails: row-level security on, no policies, and a sign-up gate on auth.users', () => {
  const t = schema.allowed_emails;
  assert.deepEqual(Object.keys(t.columns), ['email', 'note', 'created_at']);
  assert.match(SQL, /alter table public\.allowed_emails enable row level security/);
  assert.doesNotMatch(SQL, /create policy "[^"]+" on public\.allowed_emails/, 'allowed_emails must have no policies, so only the owner can read or change it');
  assert.doesNotMatch(SQL, /grant [^;]*allowed_emails/i);
  const fn = /create or replace function public\.require_invited_email\(\)([\s\S]*?)\$\$([\s\S]*?)\$\$;/.exec(SQL);
  assert.ok(fn, 'the gate function is missing');
  assert.match(fn[1], /returns trigger/);
  assert.match(fn[1], /security definer set search_path = public/, 'the function must be security definer with a fixed search_path');
  assert.match(fn[2], /lower\(email\) = lower\(new\.email\)/, 'emails are compared case-insensitively');
  assert.match(fn[2], /raise exception/);
  assert.match(SQL, /revoke execute on function public\.require_invited_email\(\) from public, anon, authenticated/);
  assert.match(SQL, /create trigger require_invited_email before insert on auth\.users\s+for each row execute function public\.require_invited_email\(\)/);
});

test('the seed has rupee rows by default, a USD side on request, and the other user in the US', () => {
  const { Store } = require('./helpers/store');
  const { seed, seedUsd, ids, OWNER, OTHER } = require('./helpers/seed');
  const store = seed(new Store(schema));
  for (const t of CURRENCY_TABLES) assert.ok(store.rows[t].filter(r => r.user_id === OWNER).every(r => r.currency === 'INR'), t + ': the owner\'s seed rows should be INR');
  assert.deepEqual(store.select('settings', r => r.user_id === OWNER).map(r => [r.default_currency, r.fy_start_month, r.timezone, r.locale]), [['INR', 4, 'Asia/Kolkata', 'en-IN']]);
  assert.deepEqual(store.select('settings', r => r.user_id === OTHER).map(r => [r.default_currency, r.fy_start_month, r.timezone]), [['USD', 1, 'America/New_York']]);
  assert.ok(store.rows.projects.find(r => r.id === ids.otherProject).currency === 'USD');
  seedUsd(store);
  for (const t of CURRENCY_TABLES) assert.ok(store.rows[t].some(r => r.user_id === OWNER && r.currency === 'USD'), t + ' should have a USD row after seedUsd');
});
