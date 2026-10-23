// An in-memory database that behaves like the real one for what the app uses: column defaults, not-null and
// check rules, foreign keys with cascade / set null, and unknown columns refused. Built from the parsed schema.
// Runs in Node (tests) and in the browser (website tests), so it has no requires.
(function (root) {
  function uuid() {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
    return require('crypto').randomUUID();
  }

  class DbError extends Error { constructor(message, code) { super(message); this.code = code; } }

  class Store {
    constructor(schema, { missing = [] } = {}) {
      this.schema = schema;
      this.rows = {};
      Object.keys(schema).filter(t => !missing.includes(t)).forEach(t => { this.rows[t] = []; });
      this.clock = Date.parse('2026-01-01T00:00:00Z');
    }
    now() { this.clock += 1000; return new Date(this.clock).toISOString(); }
    table(t) {
      if (!this.rows[t]) throw new DbError('Could not find the table \'public.' + t + '\' in the schema cache', 'PGRST205');
      return this.rows[t];
    }
    check(t, row) {
      const def = this.schema[t];
      for (const k of Object.keys(row)) if (!def.columns[k]) throw new DbError('Could not find the \'' + k + '\' column of \'' + t + '\' in the schema cache', 'PGRST204');
      for (const [k, c] of Object.entries(def.columns)) {
        const v = row[k];
        if (c.notNull && (v === null || v === undefined)) throw new DbError('null value in column "' + k + '" of relation "' + t + '" violates not-null constraint', '23502');
        if (v !== null && v !== undefined && c.references && !this.table(c.references.table).some(r => r.id === v)) throw new DbError('insert or update on table "' + t + '" violates foreign key constraint on ' + k, '23503');
      }
      for (const [k, rule] of Object.entries(def.checks)) {
        const v = row[k];
        if (v === null || v === undefined) continue;
        const ok = rule.values ? rule.values.includes(v) : rule.op === '>' ? Number(v) > rule.n : Number(v) >= rule.n;
        if (!ok) throw new DbError('new row for relation "' + t + '" violates check constraint "' + t + '_' + k + '_check"', '23514');
      }
    }
    insert(t, row, uid) {
      const def = this.schema[t], out = {};
      this.table(t);
      for (const [k, c] of Object.entries(def.columns)) {
        if (row[k] !== undefined) out[k] = row[k];
        else if (c.default) out[k] = c.default.fn === 'now' ? this.now() : c.default.fn === 'uuid' ? uuid() : c.default.fn === 'uid' ? uid : c.default.value;
        else out[k] = null;
      }
      for (const k of Object.keys(row)) if (!(k in out)) out[k] = row[k];
      if (this.rows[t].some(r => r.id === out.id)) throw new DbError('duplicate key value violates unique constraint "' + t + '_pkey"', '23505');
      this.check(t, out);
      this.rows[t].push(out);
      return { ...out };
    }
    select(t, match) { return this.table(t).filter(match).map(r => ({ ...r })); }
    update(t, match, patch) {
      const hits = this.table(t).filter(match);
      const next = hits.map(r => ({ ...r, ...patch }));
      next.forEach(r => this.check(t, r));
      hits.forEach((r, i) => Object.assign(r, next[i]));
      return next.map(r => ({ ...r }));
    }
    delete(t, match) {
      const hits = this.table(t).filter(match);
      hits.forEach(h => this.removeRow(t, h));
      return hits.map(r => ({ ...r }));
    }
    removeRow(t, row) {
      this.rows[t] = this.rows[t].filter(r => r !== row);
      // Foreign keys pointing at the deleted row: cascade deletes, set null clears, anything else refuses.
      for (const [ct, def] of Object.entries(this.schema)) {
        if (!this.rows[ct]) continue;
        for (const [col, c] of Object.entries(def.columns)) {
          if (!c.references || c.references.table !== t) continue;
          for (const child of this.rows[ct].filter(r => r[col] === row.id)) {
            if (c.references.onDelete === 'cascade') this.removeRow(ct, child);
            else if (c.references.onDelete === 'set null') child[col] = null;
            else throw new DbError('update or delete on table "' + t + '" violates foreign key constraint on ' + ct, '23503');
          }
        }
      }
    }
    // Everything except activity_log, sorted, for "is the data exactly as it was" comparisons.
    snapshot() {
      const out = {};
      Object.keys(this.rows).filter(t => t !== 'activity_log').sort().forEach(t => { out[t] = this.rows[t].map(r => ({ ...r })).sort((a, b) => a.id.localeCompare(b.id)); });
      return out;
    }
  }

  const api = { Store, DbError };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FakeStore = api;
})(typeof window !== 'undefined' ? window : globalThis);
