// Tasks and time: what the project shows, what needs attention, and every change tool (with undo), from the seed ledger.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers/setup');
const { ids, OTHER } = require('./helpers/seed');
const { TOOLS } = require('../api/_lib/tools');
const { Invalid } = require('../api/_lib/writes');
const { load } = require('../api/_lib/ledger');

const call = (db, name, args = {}) => TOOLS.find(x => x.name === name).run(db, args);
const rows = (store, table) => store.rows[table];
const theirs = store => JSON.stringify(Object.values(store.rows).flat().filter(r => r.user_id === OTHER));

async function changeAndUndo(ctx, name, args, check) {
  const before = ctx.store.snapshot(), other = theirs(ctx.store);
  const r = await call(ctx.db, name, args);
  assert.equal(r.done, true, JSON.stringify(r));
  if (check) await check(r);
  assert.notDeepEqual(ctx.store.snapshot(), before, name + ' changed nothing');
  const u = await call(ctx.db, 'undo_change', { change_id: r.change_id });
  assert.equal(u.done, true, JSON.stringify(u));
  assert.deepEqual(ctx.store.snapshot(), before, 'undo of ' + name + ' left the data different');
  assert.equal(theirs(ctx.store), other, name + ' touched another user\'s rows');
  return r;
}

test('earned per hour is money received over hours logged, and shows nothing without time', async t => {
  const { db } = setup(t);
  const L = await load(db);
  const gb = L.getProject({ project: 'GeekBoz Website' });
  assert.deepEqual(gb.time, { minutes: 390, hours: 6.5, earnedPerHour: 3076.92 }); // 20,000 received over 6.5 hours
  assert.deepEqual(gb.tasks, { open: 3, done: 1, overdue: 1 });
  assert.deepEqual(gb.timeEntries.map(e => [e.date, e.minutes, e.note]), [['2026-10-10', 90, 'Revisions'], ['2026-10-05', 300, 'Homepage design']]);
  const edu = L.getProject({ project: 'Edustudy Website' }); // money received, but no time logged
  assert.equal(edu.time, undefined);
  assert.equal(edu.tasks, undefined);
  assert.equal(edu.taskList, undefined);
  assert.equal(L.projectTime(L.project(ids.eduSite)).earnedPerHour, null);
});

test('tasks list open ones first by due date, done ones last', async t => {
  const { db } = setup(t);
  const L = await load(db);
  assert.deepEqual(L.getProject({ project: 'GeekBoz Website' }).taskList.map(x => [x.title, x.done, x.overdue]),
    [['Send design for approval', false, true], ['Set up hosting', false, false], ['Write launch email', false, false], ['Buy the domain', true, false]]);
  assert.deepEqual(L.listTasks().tasks.map(x => x.title), ['Send design for approval', 'Set up hosting', 'Write launch email']); // open by default; the other user's task is left out
  assert.deepEqual(L.listTasks({ status: 'done' }).tasks.map(x => x.title), ['Buy the domain']);
  assert.deepEqual(L.listTasks({ status: 'overdue' }).tasks.map(x => x.title), ['Send design for approval']);
  assert.equal(L.listTasks({ status: 'all' }).count, 4);
  assert.equal(L.listTasks({ client: 'Edustudy' }).count, 0);
  assert.match(L.listTasks({ status: 'nope' }).error, /status must be/);
});

test('overdue tasks and tasks due this week show up in attention', async t => {
  const { db } = setup(t);
  const a = (await load(db)).attention();
  assert.deepEqual(a.overdueTasks.map(x => x.title), ['Send design for approval']);
  assert.deepEqual(a.tasksDueWithinAWeek.map(x => x.title), ['Set up hosting']);
});

test('time logged: totals, per project, and by period', async t => {
  const { db } = setup(t);
  const L = await load(db);
  const all = L.listTime();
  assert.deepEqual([all.totalMinutes, all.totalHours, all.count], [390, 6.5, 2]);
  assert.deepEqual(all.byProject, [{ project: 'Website (GeekBoz)', hours: 6.5 }]);
  assert.deepEqual(L.listTime({ from: '2026-10-08' }).entries.map(e => e.minutes), [90]);
  assert.equal(L.listTime({ project: 'Edustudy Website' }).totalMinutes, 0);
  assert.equal(L.listTime({ client: 'GeekBoz' }).totalMinutes, 390);
});

test('add several tasks at once, then undo', async t => {
  const ctx = setup(t);
  await changeAndUndo(ctx, 'add_task', { project: 'GeekBoz Website', tasks: [{ title: 'Collect logo' }, { title: 'Launch', due_date: '2026-11-15' }, 'Plain string works too'] }, r => {
    assert.deepEqual(r.tasks.map(x => [x.title, x.dueDate]), [['Collect logo', null], ['Launch', '2026-11-15'], ['Plain string works too', null]]);
    assert.deepEqual(rows(ctx.store, 'tasks').filter(x => x.title === 'Launch').map(x => [x.project_id, x.done]), [[ids.gbSite, false]]);
  });
  await assert.rejects(call(ctx.db, 'add_task', { project: 'GeekBoz Website', tasks: [] }), Invalid);
  await assert.rejects(call(ctx.db, 'add_task', { project: 'GeekBoz Website', tasks: [{ title: '  ' }] }), /needs a title/);
  await assert.rejects(call(ctx.db, 'add_task', { project: 'GeekBoz Website', tasks: [{ title: 'x', due_date: '31 Oct' }] }), /YYYY-MM-DD/);
  assert.match((await call(ctx.db, 'add_task', { project: 'Website', tasks: [{ title: 'x' }] })).error, /Several projects match/);
});

test('tick a task off and reopen it: done_at is set and cleared', async t => {
  const ctx = setup(t);
  await changeAndUndo(ctx, 'update_task', { task: 'Set up hosting', done: true }, r => {
    const row = rows(ctx.store, 'tasks').find(x => x.id === ids.taskHosting);
    assert.equal(row.done, true);
    assert.ok(row.done_at);
    assert.equal(r.task.done, true);
  });
  await changeAndUndo(ctx, 'update_task', { task: 'Buy the domain', done: false }, () => {
    const row = rows(ctx.store, 'tasks').find(x => x.id === ids.taskDomain);
    assert.deepEqual([row.done, row.done_at], [false, null]);
  });
  await changeAndUndo(ctx, 'update_task', { task: 'Write launch email', title: 'Write the launch email', due_date: '2026-10-30' });
  await assert.rejects(call(ctx.db, 'update_task', { task: 'Write launch email' }), /Say what to change/);
  await assert.rejects(call(ctx.db, 'update_task', { task: 'Write launch email', done: 'yes' }), /true or false/);
  assert.match((await call(ctx.db, 'update_task', { task: 'nothing like this' })).error, /No task matches/);
});

test('delete a task is two-step, and undo brings it back', async t => {
  const ctx = setup(t);
  const preview = await call(ctx.db, 'delete_task', { task: 'Write launch email' });
  assert.equal(preview.confirmation_required, true);
  assert.equal(rows(ctx.store, 'tasks').length, 5);
  await changeAndUndo(ctx, 'delete_task', { task: 'Write launch email', confirm: true }, () => {
    assert.equal(rows(ctx.store, 'tasks').some(x => x.id === ids.taskEmail), false);
  });
});

test('log time in minutes or hours, with checks, then undo', async t => {
  const ctx = setup(t);
  await changeAndUndo(ctx, 'log_time', { project: 'GeekBoz Website', hours: 1.5, note: 'Mobile fixes', date: '2026-10-22' }, r => {
    assert.deepEqual([r.entry.minutes, r.entry.hours, r.entry.date, r.entry.note], [90, 1.5, '2026-10-22', 'Mobile fixes']);
    assert.deepEqual(r.projectTime, { minutes: 480, hours: 8, earnedPerHour: 2500 });
  });
  await changeAndUndo(ctx, 'log_time', { project: 'Edustudy Website', minutes: 45 }, () => {
    assert.equal(rows(ctx.store, 'time_entries').find(x => x.project_id === ids.eduSite).date, '2026-10-23'); // today by default
  });
  await assert.rejects(call(ctx.db, 'log_time', { project: 'GeekBoz Website' }), /minutes or hours/);
  await assert.rejects(call(ctx.db, 'log_time', { project: 'GeekBoz Website', minutes: 30, hours: 1 }), /minutes or hours/);
  await assert.rejects(call(ctx.db, 'log_time', { project: 'GeekBoz Website', minutes: 0 }), /above 0/);
  await assert.rejects(call(ctx.db, 'log_time', { project: 'GeekBoz Website', minutes: 90.5 }), /whole number/);
  await assert.rejects(call(ctx.db, 'log_time', { project: 'GeekBoz Website', hours: 30 }), /24 hours/);
});

test('deleting a project removes its tasks and time, and one undo restores them with the project', async t => {
  const ctx = setup(t);
  const preview = await call(ctx.db, 'delete_project', { project: 'GeekBoz Website' });
  assert.deepEqual([preview.tasks, preview.timeEntries], [4, 2]);
  await changeAndUndo(ctx, 'delete_project', { project: 'GeekBoz Website', confirm: true }, () => {
    assert.equal(rows(ctx.store, 'tasks').filter(x => x.project_id === ids.gbSite).length, 0);
    assert.equal(rows(ctx.store, 'time_entries').filter(x => x.project_id === ids.gbSite).length, 0);
    assert.equal(rows(ctx.store, 'tasks').filter(x => x.project_id === ids.otherProject).length, 1); // the other user's stay
  });
});

test('deleting a client removes the tasks and time on their projects, and undo restores them', async t => {
  const ctx = setup(t);
  const preview = await call(ctx.db, 'delete_client', { client: 'GeekBoz' });
  assert.deepEqual([preview.tasks, preview.timeEntries], [4, 2]);
  await changeAndUndo(ctx, 'delete_client', { client: 'GeekBoz', confirm: true }, () => {
    assert.equal(rows(ctx.store, 'tasks').filter(x => x.project_id === ids.gbSite).length, 0);
  });
});

test('undoing the creation of a project refuses while tasks were added to it later', async t => {
  const ctx = setup(t);
  const made = await call(ctx.db, 'create_project', { client: 'Edustudy', title: 'Brand site' });
  await call(ctx.db, 'add_task', { project: 'Brand site', client: 'Edustudy', tasks: [{ title: 'Kickoff call' }] });
  const u = await call(ctx.db, 'undo_change', { change_id: made.change_id });
  assert.match(u.error, /newer item/);
});
