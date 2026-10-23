// A small, known ledger used by most tests. "Today" in the tests is 2026-10-23 (India time).
// Numbers worth knowing:
//   all time   revenue 40,000  spending 1,500  profit 38,500
//   this month revenue 20,000  spending 1,000  (one undated entry is only in all time)
//   still to collect 30,000 (GeekBoz Website: 50,000 quoted, 20,000 paid); Edustudy App is a lead worth 80,000
//   GeekBoz Website milestones: Advance 20,000 (paid), Design 15,000 due 15 Oct (overdue by 8 days), Launch 15,000 due 28 Oct (due this week)
//   Edustudy App has a milestone with a past due date, but it's a lead, so it's never overdue
//   Invoices (business details set, UPI mec@okhdfcbank, 7 days' terms):
//     INV/2026-27/001 GeekBoz Website Advance 20,000: paid by the Advance payment
//     INV/2026-27/002 GeekBoz Website Design 15,000: sent, due 15 Oct, overdue by 8 days, reminded once on 18 Oct
//     INV/2026-27/003 Edustudy (no project) 2,500 in two lines: draft
//     INV/2025-26/001 Edustudy Website 15,000: paid by the Final payment (last financial year)
//     INV/2025-26/002 Edustudy 5,000: cancelled
//   Services (renewals): geekboz.in domain, cost 800 / price 1,500 yearly, renews 5 Nov (in 13 days)
//                        Hostinger Business hosting, 3,000 / 6,000 yearly, was due 20 Oct (overdue)
//                        Edustudy monthly care plan, 0 / 2,000 monthly, renews 1 Dec
//                        Edustudy Google Workspace, stopped (inactive)
//     yearly from active ones: revenue 31,500, cost 3,800, profit 27,700
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
  otherMs: 'eeeeeeee-0000-4000-8000-000000000005',
  invAdvance: 'ffffffff-0000-4000-8000-000000000001',
  invDesign: 'ffffffff-0000-4000-8000-000000000002',
  invDraft: 'ffffffff-0000-4000-8000-000000000003',
  invOld: 'ffffffff-0000-4000-8000-000000000004',
  invCancelled: 'ffffffff-0000-4000-8000-000000000005',
  otherInv: 'ffffffff-0000-4000-8000-000000000006',
  svcDomain: '99999999-0000-4000-8000-000000000001',
  svcHosting: '99999999-0000-4000-8000-000000000002',
  svcCare: '99999999-0000-4000-8000-000000000003',
  svcStopped: '99999999-0000-4000-8000-000000000004',
  otherSvc: '99999999-0000-4000-8000-000000000005'
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
  store.insert('settings', { business_name: 'Mec Web Studio', address: '12 MG Road, Kochi', phone: '90000 00000', email: 'hi@mec.dev', upi_id: 'mec@okhdfcbank',
    bank_details: 'Mec Web Studio\nA/c 1234567890\nIFSC HDFC0001234', invoice_prefix: 'INV', payment_terms_days: 7, invoice_notes: 'Thank you!' }, OWNER);
  const inv = (id, client_id, project_id, milestone_id, number, issue_date, due_date, items, status, extra = {}, uid = OWNER) => store.insert('invoices',
    { id, client_id, project_id, milestone_id, number, issue_date, due_date, items, total: items.reduce((a, i) => a + i.quantity * i.rate, 0), status, ...extra }, uid);
  inv(ids.invAdvance, ids.geekboz, ids.gbSite, ids.msAdvance, 'INV/2026-27/001', '2026-09-25', '2026-10-02', [{ description: 'Website — Advance', quantity: 1, rate: 20000 }], 'sent', { sent_at: '2026-09-25T10:00:00Z' });
  inv(ids.invDesign, ids.geekboz, ids.gbSite, ids.msDesign, 'INV/2026-27/002', '2026-10-08', '2026-10-15', [{ description: 'Website — Design', quantity: 1, rate: 15000 }], 'sent', { sent_at: '2026-10-08T10:00:00Z', last_reminded: '2026-10-18', reminder_count: 1 });
  inv(ids.invDraft, ids.edustudy, null, null, 'INV/2026-27/003', '2026-10-22', '2026-10-29', [{ description: 'Hosting renewal', quantity: 1, rate: 500 }, { description: 'Support hours', quantity: 2, rate: 1000 }], 'draft');
  inv(ids.invOld, ids.edustudy, ids.eduSite, null, 'INV/2025-26/001', '2026-03-10', '2026-03-17', [{ description: 'Website — final payment', quantity: 1, rate: 15000 }], 'sent');
  inv(ids.invCancelled, ids.edustudy, null, null, 'INV/2025-26/002', '2026-03-20', '2026-03-27', [{ description: 'Extra pages', quantity: 1, rate: 5000 }], 'cancelled');
  store.update('txns', r => r.id === ids.advance, { invoice_id: ids.invAdvance });
  store.update('txns', r => r.id === ids.eduFinal, { invoice_id: ids.invOld });
  const svc = (id, client_id, project_id, kind, name, cost, price, cycle, next_renewal, extra = {}, uid = OWNER) =>
    store.insert('services', { id, client_id, project_id, kind, name, cost, price, cycle, next_renewal, ...extra }, uid);
  svc(ids.svcDomain, ids.geekboz, ids.gbSite, 'domain', 'geekboz.in', 800, 1500, 'yearly', '2026-11-05', { provider: 'GoDaddy' });
  svc(ids.svcHosting, ids.geekboz, ids.gbSite, 'hosting', 'Hostinger Business', 3000, 6000, 'yearly', '2026-10-20', { provider: 'Hostinger', auto_renew: true });
  svc(ids.svcCare, ids.edustudy, ids.eduSite, 'maintenance', 'Monthly care plan', 0, 2000, 'monthly', '2026-12-01');
  svc(ids.svcStopped, ids.edustudy, null, 'email', 'Google Workspace', 1500, 2000, 'yearly', '2026-10-25', { active: false });
  // Someone else's data in the same database, which must never show up or change.
  c(ids.otherClient, 'GeekBoz', { contact: 'not yours' }, OTHER);
  p(ids.otherProject, ids.otherClient, 'Website', { quoted: 99999 }, OTHER);
  t(ids.otherTxn, ids.otherClient, ids.otherProject, 'in', 77777, { note: 'Advance', date: '2026-10-10' }, OTHER);
  m(ids.otherMs, ids.otherProject, 'Theirs', 99999, '2026-01-01', 0, OTHER);
  store.insert('settings', { business_name: 'Not yours', upi_id: 'other@ybl' }, OTHER);
  svc(ids.otherSvc, ids.otherClient, ids.otherProject, 'domain', 'geekboz.in', 1, 99999, 'yearly', '2026-10-24', {}, OTHER);
  inv(ids.otherInv, ids.otherClient, ids.otherProject, null, 'INV/2026-27/001', '2026-10-01', '2026-10-08', [{ description: 'Theirs', quantity: 1, rate: 99999 }], 'sent', {}, OTHER);
  return store;
}

// Fixes "now" for the test, so periods and "today" are predictable.
function freezeTime(t, at = NOW) {
  t.mock.timers.enable({ apis: ['Date'], now: at });
}

module.exports = { seed, ids, OWNER, OTHER, NOW, freezeTime, mock };
