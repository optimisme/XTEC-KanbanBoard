import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createScenario, db, groupTaskOf, login, setup, teardown } from './helpers.js';

let s;
let teacher;
let student1;
let student2;
let student3;
let gtA; // Task A in group 0
let gtB; // Task B in group 0
let gtC; // Task C in group 0

before(async () => {
  await setup();
  s = await createScenario();
  teacher = await login(s.users.teacher.email);
  student1 = await login(s.users.s1.email);
  student2 = await login(s.users.s2.email);
  student3 = await login(s.users.s3.email);
  gtA = (await groupTaskOf(student1, s.group0.id, s.tasks[0].id)).id;
  gtB = (await groupTaskOf(student1, s.group0.id, s.tasks[1].id)).id;
  gtC = (await groupTaskOf(student1, s.group0.id, s.tasks[2].id)).id;
});
after(teardown);

const setStatus = (client, id, status, extra = {}) => client.post(`/api/group-tasks/${id}/status`, { status, ...extra });

test('13. starting an unassigned pending task assigns the acting student', async () => {
  const res = await setStatus(student1, gtA, 'in_progress');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'in_progress');
  assert.equal(res.body.responsible.id, s.users.s1.id);
  assert.ok(res.body.assigned_at);
  assert.deepEqual(res.body.history.map((h) => h.event_type), ['started', 'auto_assigned']);
  assert.equal(res.body.history[1].new_user_name, 'Student 1');

  // The same task in another group is untouched.
  const other = await groupTaskOf(student3, s.group1.id, s.tasks[0].id);
  assert.equal(other.status, 'pending');
  assert.equal(other.responsible, null);
});

test('a teacher changing a state never becomes the responsible student', async () => {
  const res = await setStatus(teacher, gtC, 'in_progress');
  assert.equal(res.status, 200);
  assert.equal(res.body.responsible, null);
  // A student moving that unassigned task back into progress gets assigned.
  await setStatus(teacher, gtC, 'pending');
  const started = await setStatus(student2, gtC, 'in_progress');
  assert.equal(started.body.responsible.id, s.users.s2.id);
  await setStatus(teacher, gtC, 'pending');
  await teacher.post(`/api/group-tasks/${gtC}/responsible`, { user_id: null });
});

test('transition policy is enforced on the backend', async () => {
  // Students cannot jump from pending to completed or blocked.
  assert.equal((await setStatus(student1, gtB, 'completed')).body.error.code, 'invalid_transition');
  assert.equal((await setStatus(student1, gtB, 'blocked', { reason: 'x' })).body.error.code, 'invalid_transition');
  assert.equal((await setStatus(student1, gtA, 'in_progress')).status, 409); // already there
  assert.equal((await setStatus(student1, gtA, 'nonsense')).status, 400);
  // The board advertises exactly the allowed targets.
  const card = await groupTaskOf(student1, s.group0.id, s.tasks[1].id);
  assert.deepEqual(card.allowed_transitions, ['in_progress']);
  const teacherCard = await groupTaskOf(teacher, s.group0.id, s.tasks[1].id);
  assert.deepEqual(teacherCard.allowed_transitions, ['in_progress', 'blocked', 'completed']);
});

test('14. tasks have at most one responsible student (schema level)', async () => {
  const columns = await db.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'group_tasks' AND COLUMN_NAME LIKE 'responsible%'`
  );
  assert.deepEqual(columns.map((c) => c.COLUMN_NAME), ['responsible_user_id']);
  // The responsible student must belong to the group: enforced by a foreign key.
  await assert.rejects(db.query('UPDATE group_tasks SET responsible_user_id = ? WHERE id = ?', [s.users.s3.id, gtA]), {
    code: 'ER_NO_REFERENCED_ROW_2',
  });
});

test('15 & 20. another member completes the task; responsibility is preserved', async () => {
  const res = await setStatus(student2, gtA, 'completed');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'completed');
  assert.equal(res.body.responsible.id, s.users.s1.id); // still Student 1
  assert.equal(res.body.completed_by.id, s.users.s2.id); // completed by Student 2
  assert.ok(res.body.completed_at);
  assert.equal(res.body.completed_version, res.body.definition.version);
  const event = res.body.history.at(-1);
  assert.equal(event.event_type, 'completed');
  assert.equal(event.actor_id, s.users.s2.id);
});

test('21. reopening a completed task preserves completion history', async () => {
  const res = await setStatus(student1, gtA, 'in_progress');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'in_progress');
  assert.equal(res.body.responsible.id, s.users.s1.id);
  assert.equal(res.body.completed_at, null);
  assert.equal(res.body.completed_by, null);
  const types = res.body.history.map((h) => h.event_type);
  assert.deepEqual(types, ['started', 'auto_assigned', 'completed', 'reopened']);
  assert.equal(res.body.history[2].actor_name, 'Student 2');
});

test('16. the responsible student can transfer the task to a group member', async () => {
  const res = await student1.post(`/api/group-tasks/${gtA}/responsible`, { user_id: s.users.s2.id });
  assert.equal(res.status, 200);
  assert.equal(res.body.responsible.id, s.users.s2.id);
  const event = res.body.history.at(-1);
  assert.equal(event.event_type, 'responsibility_transferred');
  assert.equal(event.old_user_name, 'Student 1');
  assert.equal(event.new_user_name, 'Student 2');
  assert.equal(event.actor_id, s.users.s1.id);
  assert.ok(event.created_at);
});

test('17. students cannot transfer another student’s responsibility', async () => {
  // Student 1 is no longer responsible.
  const res = await student1.post(`/api/group-tasks/${gtA}/responsible`, { user_id: s.users.s1.id });
  assert.equal(res.status, 403);
  // Nor can the responsible student hand it to someone outside the group.
  assert.equal((await student2.post(`/api/group-tasks/${gtA}/responsible`, { user_id: s.users.s3.id })).status, 400);
  assert.equal((await student2.post(`/api/group-tasks/${gtA}/responsible`, { user_id: null })).status, 400);
  assert.equal((await groupTaskOf(student1, s.group0.id, s.tasks[0].id)).responsible.id, s.users.s2.id);
  // A teacher can reassign.
  const byTeacher = await teacher.post(`/api/group-tasks/${gtA}/responsible`, { user_id: s.users.s1.id });
  assert.equal(byTeacher.body.responsible.id, s.users.s1.id);
});

test('18. blocking requires a reason', async () => {
  for (const body of [{}, { reason: '' }, { reason: '   ' }]) {
    const res = await setStatus(student1, gtA, 'blocked', body);
    assert.equal(res.status, 400);
  }
  assert.equal((await groupTaskOf(student1, s.group0.id, s.tasks[0].id)).status, 'in_progress');

  const res = await setStatus(student2, gtA, 'blocked', { reason: 'Waiting for the database server' });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'blocked');
  assert.equal(res.body.block_reason, 'Waiting for the database server');
  assert.equal(res.body.responsible.id, s.users.s1.id); // responsibility kept
  assert.equal(res.body.block_events.length, 1);
  assert.equal(res.body.block_events[0].unblocked_at, null);
  assert.equal(res.body.comments.at(-1).type, 'block');

  // Teacher dashboard lists it; unassigned teachers see nothing.
  const dashboard = (await teacher.get('/api/blocked-tasks')).body;
  assert.equal(dashboard.length, 1);
  assert.equal(dashboard[0].reason, 'Waiting for the database server');
  assert.equal(dashboard[0].responsible_name, 'Student 1');
  assert.equal(dashboard[0].group_number, 0);
  const other = await login(s.users.otherTeacher.email);
  assert.deepEqual((await other.get('/api/blocked-tasks')).body, []);
});

test('19. unblocking preserves blocking history', async () => {
  const res = await setStatus(student1, gtA, 'in_progress');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'in_progress');
  assert.equal(res.body.block_reason, null);
  const [event] = res.body.block_events;
  assert.equal(event.reason, 'Waiting for the database server');
  assert.equal(event.blocked_by_name, 'Student 2');
  assert.equal(event.unblocked_by_name, 'Student 1');
  assert.ok(event.unblocked_at);
  assert.ok(event.duration_seconds >= 0);
  assert.equal(res.body.history.at(-1).event_type, 'unblocked');

  // A second block creates a second event; the first one stays.
  await setStatus(student1, gtA, 'blocked', { reason: 'Second problem' });
  const again = await setStatus(teacher, gtA, 'in_progress');
  assert.equal(again.body.block_events.length, 2);
  assert.deepEqual(again.body.block_events.map((e) => e.reason).sort(), ['Second problem', 'Waiting for the database server']);
  assert.deepEqual((await teacher.get('/api/blocked-tasks')).body, []);
});

test('27. concurrent task updates cannot produce inconsistent assignments', async () => {
  const results = await Promise.all([
    setStatus(student1, gtB, 'in_progress', { expected_status: 'pending' }),
    setStatus(student2, gtB, 'in_progress', { expected_status: 'pending' }),
  ]);
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 409]);
  const winner = results.find((r) => r.status === 200);
  const final = (await student1.get(`/api/group-tasks/${gtB}`)).body;
  assert.equal(final.status, 'in_progress');
  assert.equal(final.responsible.id, winner.body.responsible.id);
  assert.equal(final.history.filter((h) => h.event_type === 'auto_assigned').length, 1);
  assert.equal(final.history.filter((h) => h.event_type === 'started').length, 1);

  // A stale client (old expected state) is rejected instead of overwriting.
  const stale = await setStatus(student1, gtB, 'completed', { expected_status: 'pending' });
  assert.equal(stale.body.error.code, 'stale_task');

  // Many simultaneous transfers still leave exactly one consistent result.
  const owner = final.responsible.id === s.users.s1.id ? student1 : student2;
  const target = final.responsible.id === s.users.s1.id ? s.users.s2.id : s.users.s1.id;
  const transfers = await Promise.all(
    Array.from({ length: 5 }, () => owner.post(`/api/group-tasks/${gtB}/responsible`, { user_id: target }))
  );
  assert.equal(transfers.filter((r) => r.status === 200).length, 1);
  const end = (await student1.get(`/api/group-tasks/${gtB}`)).body;
  assert.equal(end.responsible.id, target);
  assert.equal(end.history.filter((h) => h.event_type === 'responsibility_transferred').length, 1);
});

test('comments: students and teachers can comment; history records it', async () => {
  const comment = await student1.post(`/api/group-tasks/${gtA}/comments`, { content: 'First comment' });
  assert.equal(comment.status, 201);
  assert.equal((await student1.post(`/api/group-tasks/${gtA}/comments`, { content: '  ' })).status, 400);
  assert.equal((await teacher.post(`/api/group-tasks/${gtA}/comments`, { content: 'Teacher feedback' })).status, 201);
  assert.equal((await student3.post(`/api/group-tasks/${gtA}/comments`, { content: 'Outsider' })).status, 403);

  const detail = (await student1.get(`/api/group-tasks/${gtA}`)).body;
  assert.equal(detail.comment_count, 2);
  assert.deepEqual(detail.comments.filter((c) => c.type === 'comment').map((c) => c.author_name), ['Student 1', 'Teacher A']);
  assert.equal(detail.history.filter((h) => h.event_type === 'comment_added').length, 2);

  // The evidence feature and the acceptance criteria field no longer exist.
  assert.equal('attachments' in detail, false);
  assert.equal('acceptance_criteria' in detail.definition, false);
  assert.equal((await student1.post(`/api/group-tasks/${gtA}/attachments`, { url: 'https://example.com' })).status, 404);
  const leftovers = await db.query(
    `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND (TABLE_NAME = 'task_attachments' OR COLUMN_NAME = 'acceptance_criteria')`
  );
  assert.equal(leftovers.length, 0);
});

test('supervision: progress matrix and student contributions', async () => {
  const matrix = (await teacher.get(`/api/projects/${s.project.id}/matrix`)).body;
  assert.deepEqual(matrix.tasks.map((t) => t.title), ['Task A', 'Task B', 'Task C']);
  assert.equal(matrix.groups.length, 2);
  const cell = matrix.groups[0].cells[s.tasks[0].id];
  assert.equal(cell.group_task_id, gtA);
  assert.equal(cell.status, 'in_progress');
  assert.equal(matrix.groups[1].cells[s.tasks[0].id].status, 'pending');

  // Tag filter keeps the global order.
  const filtered = (await teacher.get(`/api/projects/${s.project.id}/matrix?tag_id=${s.tags.databases.id}`)).body;
  assert.deepEqual(filtered.tasks.map((t) => t.title), ['Task B', 'Task C']);

  const contrib = (await teacher.get(`/api/projects/${s.project.id}/students/${s.users.s2.id}/contributions`)).body;
  assert.equal(contrib.student.name, 'Student 2');
  assert.equal(contrib.group.group_number, 0);
  // Student 2 blocked Task A without being responsible for it.
  assert.ok(contrib.block_events.some((e) => e.reason === 'Waiting for the database server'));
  assert.ok(contrib.activity.some((e) => e.event_type === 'completed'));
  assert.ok(contrib.transfers.length >= 1);
  assert.ok(!contrib.assigned.some((t) => t.group_task_id === gtA));

  assert.equal((await student1.get(`/api/projects/${s.project.id}/students/${s.users.s2.id}/contributions`)).status, 403);
});

test('removing a student from a group keeps history and clears responsibility', async () => {
  const before = (await student1.get(`/api/group-tasks/${gtA}`)).body;
  assert.equal(before.responsible.id, s.users.s1.id);
  const res = await s.admin.put(`/api/groups/${s.group0.id}/students`, { student_ids: [s.users.s2.id] });
  assert.equal(res.status, 200);

  assert.equal((await student1.get(`/api/groups/${s.group0.id}/board`)).status, 403);
  const after = (await student2.get(`/api/group-tasks/${gtA}`)).body;
  assert.equal(after.responsible, null);
  assert.ok(after.history.length > before.history.length);
  assert.ok(after.history.some((h) => h.actor_id === s.users.s1.id));

  // Groups with activity cannot be deleted; untouched ones can.
  assert.equal((await s.admin.del(`/api/groups/${s.group0.id}`)).status, 409);
  assert.equal((await s.admin.del(`/api/groups/${s.group1.id}`)).status, 200);
});
