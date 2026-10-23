// A stand-in for the supabase-js browser library, served in place of the CDN script during website tests.
// Data lives in window.FakeStore (tests/helpers/store.js) with the same rules as the real database, and every
// query is limited to the signed-in user like row-level security. Set up from window.__LEDGER_TEST__.
(function () {
  const init = window.__LEDGER_TEST__;
  const store = new window.FakeStore.Store(init.schema);
  store.rows = init.rows;
  window.__store = store;
  window.__calls = [];
  let session = init.signedIn ? { user: init.users[0], access_token: 'test' } : null;
  const listeners = [];
  const emit = (event) => listeners.forEach(cb => setTimeout(() => cb(event, session), 0));
  const uid = () => session && session.user.id;
  const own = extra => r => r.user_id === uid() && (!extra || extra(r));
  const err = e => ({ message: e.message, code: e.code });

  function builder(table) {
    let op = 'select', payload = null, filter = null, single = false;
    const run = () => {
      try {
        if (!uid()) return { data: null, error: { message: 'JWT expired', code: 'PGRST301' } };
        if (op === 'select') return { data: store.select(table, own()), error: null };
        if (op === 'insert') {
          const rows = [].concat(payload).map(r => {
            if (r.user_id && r.user_id !== uid()) throw Object.assign(new Error('new row violates row-level security policy'), { code: '42501' });
            return store.insert(table, r, uid());
          });
          return { data: single ? rows[0] : rows, error: null };
        }
        const match = own(filter);
        if (op === 'update') return { data: store.update(table, match, payload), error: null };
        if (op === 'delete') return { data: store.delete(table, match), error: null };
      } catch (e) { return { data: null, error: err(e) }; }
    };
    const b = {
      select() { return b; },
      insert(rows) { op = 'insert'; payload = rows; return b; },
      update(row) { op = 'update'; payload = row; return b; },
      delete() { op = 'delete'; return b; },
      eq(col, v) { const prev = filter; filter = r => (!prev || prev(r)) && r[col] === v; return b; },
      in(col, vs) { const prev = filter; filter = r => (!prev || prev(r)) && vs.includes(r[col]); return b; },
      single() { single = true; return b; },
      then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject); }
    };
    return b;
  }

  window.supabase = {
    createClient() {
      return {
        from: builder,
        auth: {
          async signInWithPassword({ email, password }) {
            window.__calls.push(['signIn', email]);
            const u = init.users.find(x => x.email === email && x.password === password);
            if (!u) return { data: null, error: { message: 'Invalid login credentials' } };
            session = { user: { id: u.id, email: u.email }, access_token: 'test' };
            emit('SIGNED_IN');
            return { data: { session }, error: null };
          },
          async signOut() { session = null; emit('SIGNED_OUT'); return { error: null }; },
          async resetPasswordForEmail(email, opts) { window.__calls.push(['reset', email, opts && opts.redirectTo]); return { data: {}, error: null }; },
          async updateUser(attrs) { window.__calls.push(['updateUser', Object.keys(attrs)]); return { data: {}, error: null }; },
          onAuthStateChange(cb) { listeners.push(cb); setTimeout(() => cb('INITIAL_SESSION', session), 0); return { data: { subscription: { unsubscribe() {} } } }; }
        }
      };
    }
  };
})();
