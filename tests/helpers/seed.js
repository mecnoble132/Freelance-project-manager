// A small, known ledger used by most tests. "Today" in the tests is 2026-10-23 (India time).
// Numbers worth knowing:
//   all time   revenue 40,000  spending 1,500  profit 38,500
//   this month revenue 20,000  spending 1,000  (one undated entry is only in all time)
//   still to collect 30,000 (GeekBoz Website: 50,000 quoted, 20,000 paid); Edustudy App is a lead worth 80,000
//   GeekBoz Website milestones: Advance 20,000 (paid), Design 15,000 due 15 Oct (overdue by 8 days), Launch 15,000 due 28 Oct (due this week)
//   Edustudy App has a milestone with a past due date, but it's a lead, so it's never overdue
const { mock } = require('node:test');

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-10-23T06:30:00Z'); // 12:00 in India

const ids = {
  geekboz: 'aaaaaaaa-0000-4000-8000-000000000001',
  edustudy: 'aaaaaaaa-0000-4000-8000-000000000002',
  gbSite: 'bbbbbbbb-0000-4000-8000-000000000001',
  eduSite: 'bbbbbbbb-0000-4000-8000-000000000002',
  eduApp: 'bbbbbbbb-0000-4000-8000-000000000003',
  advance: 'cccccccc-0000-4000-8000-000000000001',
  domain: 'cccccccc-0000-4000-8000-000000000002',
  eduFinal: 'cccccccc-0000-4000-8000-000000000003',
  undated: 'cccccccc-0000-4000-8000-000000000004',
  hosting: 'cccccccc-0000-4000-8000-000000000005',
  otherClient: 'dddddddd-0000-4000-8000-000000000001',
  otherProject: 'dddddddd-0000-4000-8000-000000000002',
  otherTxn: 'dddddddd-0000-4000-8000-000000000003',
  msAdvance: 'eeeeeeee-0000-4000-8000-000000000001',
  msDesign: 'eeeeeeee-0000-4000-8000-000000000002',
  msLaunch: 'eeeeeeee-0000-4000-8000-000000000003',
  msLead: 'eeeeeeee-0000-4000-8000-000000000004',
  otherMs: 'eeeeeeee-0000-4000-8000-000000000005'
};

function seed(store) {
  const c = (id, name, extra = {}, uid = OWNER) => store.insert('clients', { id, name, ...extra }, uid);
  const p = (id, client_id, name, extra = {}, uid = OWNER) => store.insert('projects', { id, client_id, name, ...extra }, uid);
  const t = (id, client_id, project_id, type, amount, extra = {}, uid = OWNER) => store.insert('txns', { id, client_id, project_id, type, amount, ...extra }, uid);
  c(ids.geekboz, 'GeekBoz', { contact: '98765 43210', sort_order: 0 });
  c(ids.edustudy, 'Edustudy', { contact: 'hello@edustudy.in', sort_order: 1 });
  p(ids.gbSite, ids.geekboz, 'Website', { status: 'active', quoted: 50000, due_date: '2026-10-20', start_date: '2026-09-01' });
  p(ids.eduSite, ids.edustudy, 'Website', { status: 'done', quoted: 20000 });
  p(ids.eduApp, ids.edustudy, 'App', { status: 'lead', quoted: 80000 });
  t(ids.advance, ids.geekboz, ids.gbSite, 'in', 20000, { note: 'Advance', date: '2026-10-05' });
  t(ids.domain, ids.geekboz, ids.gbSite, 'out', 1000, { note: '.com', category: 'Domain', date: '2026-10-06' });
  t(ids.eduFinal, ids.edustudy, ids.eduSite, 'in', 15000, { note: 'Final payment', date: '2026-03-15' });
  t(ids.undated, ids.edustudy, ids.eduSite, 'in', 5000, { note: 'Old payment', date: null });
  t(ids.hosting, ids.edustudy, null, 'out', 500, { note: 'Hostinger', category: 'Hosting', date: '2025-12-01' });
  const m = (id, project_id, name, amount, due_date, sort_order, uid = OWNER) => store.insert('milestones', { id, project_id, name, amount, due_date, sort_order }, uid);
  m(ids.msAdvance, ids.gbSite, 'Advance', 20000, '2026-09-01', 0);
  m(ids.msDesign, ids.gbSite, 'Design', 15000, '2026-10-15', 1);
  m(ids.msLaunch, ids.gbSite, 'Launch', 15000, '2026-10-28', 2);
  m(ids.msLead, ids.eduApp, 'Advance', 40000, '2026-10-01', 0);
  // Someone else's data in the same database, which must never show up or change.
  c(ids.otherClient, 'GeekBoz', { contact: 'not yours' }, OTHER);
  p(ids.otherProject, ids.otherClient, 'Website', { quoted: 99999 }, OTHER);
  t(ids.otherTxn, ids.otherClient, ids.otherProject, 'in', 77777, { note: 'Advance', date: '2026-10-10' }, OTHER);
  m(ids.otherMs, ids.otherProject, 'Theirs', 99999, '2026-01-01', 0, OTHER);
  return store;
}

// Fixes "now" for the test, so periods and "today" are predictable.
function freezeTime(t, at = NOW) {
  t.mock.timers.enable({ apis: ['Date'], now: at });
}

module.exports = { seed, ids, OWNER, OTHER, NOW, freezeTime, mock };
