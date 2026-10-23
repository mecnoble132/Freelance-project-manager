// Reads supabase/schema.sql into { table: { columns: { name: { type, notNull, default } }, checks } },
// so the fake database accepts exactly what the real one would and the tests catch schema drift.
const fs = require('fs');
const path = require('path');

const SQL = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'schema.sql'), 'utf8');

function parseDefault(def) {
  if (def == null) return undefined;
  if (/^'/.test(def)) return { value: def.slice(1, -1).replace(/''/g, "'") };
  if (/^now\(\)$/i.test(def)) return { fn: 'now' };
  if (/^gen_random_uuid\(\)$/i.test(def)) return { fn: 'uuid' };
  if (/^auth\.uid\(\)$/i.test(def)) return { fn: 'uid' };
  if (/^(true|false)$/i.test(def)) return { value: def.toLowerCase() === 'true' };
  if (/^-?\d+(\.\d+)?$/.test(def)) return { value: Number(def) };
  throw new Error('schema.js doesn\'t understand the default ' + def);
}

function parseColumn(line) {
  const m = /^\s*([a-z_][a-z0-9_]*)\s+([a-z]+(?:\(\d+(?:,\s*\d+)?\))?)(.*)$/i.exec(line);
  if (!m || /^(constraint|primary|unique|check|foreign)$/i.test(m[1])) return null;
  const rest = m[3];
  const d = /\bdefault\s+('(?:[^']|'')*'|[a-z_.]+\(\)|[^\s,]+)/i.exec(rest);
  const check = /\bcheck\s*\((.*)\)/i.exec(rest);
  const ref = /\breferences\s+public\.([a-z_]+)\s*\(id\)(?:\s+on delete\s+(cascade|set null))?/i.exec(rest);
  return { name: m[1], col: { type: m[2].toLowerCase().replace(/\(.*/, ''), notNull: /\bnot null\b/i.test(rest) || /\bprimary key\b/i.test(rest), default: parseDefault(d && d[1]),
    references: ref ? { table: ref[1], onDelete: (ref[2] || 'restrict').toLowerCase() } : undefined }, check: check && check[1] };
}

// "status in ('lead', 'active')" → { column, values }; "amount > 0" → { column, op, n }.
function parseInCheck(expr) {
  const m = /^\s*\(?\s*([a-z_]+)\s+in\s*\(([^)]*)\)/i.exec(expr || '');
  if (m) return { column: m[1], rule: { values: m[2].split(',').map(s => s.trim()).map(s => /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s.replace(/^'|'$/g, '')) } };
  const n = /^\s*\(?\s*([a-z_]+)\s*(>=|>)\s*(-?\d+(?:\.\d+)?)\s*\)?\s*$/.exec(expr || '');
  return n ? { column: n[1], rule: { op: n[2], n: Number(n[3]) } } : null;
}

function parse(sql = SQL) {
  const noComments = sql.replace(/--[^\n]*/g, '');
  const tables = {};
  const re = /create table if not exists public\.([a-z_]+)\s*\(([\s\S]*?)\n\);/gi;
  let m;
  while ((m = re.exec(noComments))) {
    const t = tables[m[1]] = { columns: {}, checks: {} };
    m[2].split(/,\s*\n/).forEach(line => {
      const c = parseColumn(line.replace(/\n/g, ' '));
      if (!c) return;
      t.columns[c.name] = c.col;
      const ch = parseInCheck(c.check);
      if (ch) t.checks[ch.column] = ch.rule;
    });
  }
  const add = /alter table public\.([a-z_]+)\s+add column if not exists\s+([^;]+);/gi;
  while ((m = add.exec(noComments))) {
    const c = parseColumn(m[2]);
    if (!tables[m[1]]) throw new Error('schema.sql adds a column to ' + m[1] + ' before creating it');
    tables[m[1]].columns[c.name] = c.col;
  }
  // Named constraints replace inline ones, like the real database after the drop/add pairs.
  const con = /alter table public\.([a-z_]+)\s+add constraint\s+([a-z_]+)\s+check\s*\(([^;]*)\);/gi;
  while ((m = con.exec(noComments))) {
    const ch = parseInCheck(m[3]);
    if (ch) tables[m[1]].checks[ch.column] = ch.rule;
  }
  return tables;
}

module.exports = { parse, SQL };
