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
const dataTables = Object.keys(schema).filter(t => t !== 'activity_log');
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
  const sql = SQL.replace(/--[^\n]*/g, '');
  const statements = sql.split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const dropped = { policy: new Set(), constraint: new Set() };
  for (const s of statements) {
    assert.doesNotMatch(s, /\b(drop (table|column|index|schema)|rename|alter column|truncate|delete from|update public)\b/i, 'not additive: ' + s);
    if (/^create table/i.test(s)) assert.match(s, /^create table if not exists/i, s);
    if (/^create (unique )?index/i.test(s)) assert.match(s, /if not exists/i, s);
    if (/add column/i.test(s)) assert.match(s, /add column if not exists/i, s);
    let m;
    if ((m = /^drop policy if exists "([^"]+)" on (\S+)/i.exec(s))) dropped.policy.add(m[2] + ' ' + m[1]);
    if ((m = /^create policy "([^"]+)" on (\S+)/i.exec(s))) assert.ok(dropped.policy.has(m[2] + ' ' + m[1]), 'drop policy if exists must come before: ' + s);
    if ((m = /drop constraint if exists (\S+)/i.exec(s))) dropped.constraint.add(m[1]);
    if ((m = /add constraint (\S+)/i.exec(s))) assert.ok(dropped.constraint.has(m[1]), 'drop constraint if exists must come before: ' + s);
  }
});

test('every table has row-level security and an own-rows policy', () => {
  for (const t of Object.keys(schema)) {
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
