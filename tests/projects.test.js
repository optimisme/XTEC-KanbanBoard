import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createScenario, db, groupTaskOf, login, setup, teardown } from './helpers.js';

let s;
let teacher;
let otherTeacher;
let student1;
let student3;

before(async () => {
  await setup();
  s = await createScenario();
  teacher = await login(s.users.teacher.email);
  otherTeacher = await login(s.users.otherTeacher.email);
  student1 = await login(s.users.s1.email);
  student3 = await login(s.users.s3.email);
});
after(teardown);

const taskBody = (overrides = {}) => ({
  title: 'New task',
  description: 'Text',
  acceptance_criteria: '- Done',
  module_ids: [s.modules.programming.id],
  ...overrides,
});

test('4. teachers only access assigned projects', async () => {
  assert.deepEqual((await teacher.get('/api/projects')).body.map((p) => p.id), [s.project.id]);
  assert.equal((await teacher.get(`/api/projects/${s.project.id}`)).status, 200);
  assert.equal((await teacher.get(`/api/groups/${s.group1.id}/board`)).status, 200);

  assert.deepEqual((await otherTeacher.get('/api/projects')).body, []);
  for (const url of [
    `/api/projects/${s.project.id}`,
    `/api/projects/${s.project.id}/tasks`,
    `/api/projects/${s.project.id}/matrix`,
    `/api/groups/${s.group0.id}/board`,
    `/api/tasks/${s.tasks[0].id}`,
  ]) {
    assert.equal((await otherTeacher.get(url)).status, 403, url);
  }
  assert.equal((await otherTeacher.post(`/api/projects/${s.project.id}/tasks`, taskBody())).status, 403);
  assert.equal((await otherTeacher.put(`/api/tasks/${s.tasks[0].id}`, taskBody())).status, 403);
  const gt = await groupTaskOf(s.admin, s.group0.id, s.tasks[0].id);
  assert.equal((await otherTeacher.post(`/api/group-tasks/${gt.id}/status`, { status: 'in_progress' })).status, 403);
});

test('5. an assigned teacher manages every task regardless of its modules', async () => {
  // Task B belongs only to "Databases"; there is no teacher-module relation at all.
  const res = await teacher.put(`/api/tasks/${s.tasks[1].id}`, taskBody({ title: 'Task B', description: 'Edited by teacher', module_ids: [s.modules.databases.id] }));
  assert.equal(res.status, 200);
  assert.equal(res.body.description, 'Edited by teacher');

  const gt = await groupTaskOf(teacher, s.group1.id, s.tasks[1].id);
  assert.equal((await teacher.post(`/api/group-tasks/${gt.id}/status`, { status: 'in_progress' })).status, 200);
  assert.equal((await teacher.post(`/api/group-tasks/${gt.id}/status`, { status: 'pending' })).status, 200);

  const tables = await db.query("SHOW TABLES LIKE 'teacher_modules'");
  assert.equal(tables.length, 0);
});

test('6. students cannot access other groups', async () => {
  assert.equal((await student1.get(`/api/groups/${s.group0.id}/board`)).status, 200);
  assert.equal((await student1.get(`/api/groups/${s.group1.id}/board`)).status, 403);

  const foreign = await groupTaskOf(s.admin, s.group1.id, s.tasks[0].id);
  assert.equal((await student1.get(`/api/group-tasks/${foreign.id}`)).status, 403);
  assert.equal((await student1.post(`/api/group-tasks/${foreign.id}/status`, { status: 'in_progress' })).status, 403);
  assert.equal((await student1.post(`/api/group-tasks/${foreign.id}/comments`, { content: 'hi' })).status, 403);
  assert.equal((await student1.get(`/api/group-tasks/${foreign.id}/history`)).status, 403);

  // The project view only exposes the student's own group.
  const project = (await student1.get(`/api/projects/${s.project.id}`)).body;
  assert.deepEqual(project.groups.map((g) => g.id), [s.group0.id]);
  // Supervision views are not for students.
  assert.equal((await student1.get(`/api/projects/${s.project.id}/matrix`)).status, 403);
  assert.equal((await student1.get('/api/blocked-tasks')).status, 403);
});

test('7. students cannot edit shared task definitions', async () => {
  assert.equal((await student1.post(`/api/projects/${s.project.id}/tasks`, taskBody())).status, 403);
  assert.equal((await student1.put(`/api/tasks/${s.tasks[0].id}`, taskBody({ title: 'Hacked' }))).status, 403);
  assert.equal((await student1.del(`/api/tasks/${s.tasks[0].id}`)).status, 403);
  assert.equal((await student1.get(`/api/tasks/${s.tasks[0].id}/versions`)).status, 403);
  // Reading the definition is allowed.
  const read = await student1.get(`/api/tasks/${s.tasks[0].id}`);
  assert.equal(read.status, 200);
  assert.equal(read.body.title, 'Task A');
});

test('8. new shared tasks appear in all existing groups', async () => {
  const created = await teacher.post(`/api/projects/${s.project.id}/tasks`, taskBody({ title: 'Task D' }));
  assert.equal(created.status, 201);
  s.tasks.push(created.body);
  for (const group of [s.group0, s.group1]) {
    const gt = await groupTaskOf(s.admin, group.id, created.body.id);
    assert.equal(gt.status, 'pending');
    assert.equal(gt.responsible, null);
  }
  const rows = await db.query(
    'SELECT group_id, task_id, COUNT(*) AS n FROM group_tasks GROUP BY group_id, task_id HAVING n <> 1'
  );
  assert.equal(rows.length, 0);
});

test('9. new groups receive all existing task definitions', async () => {
  const project = (await s.admin.post(`/api/projects/${s.project.id}/groups`, { student_ids: [s.users.s4.id] })).body;
  const group2 = project.groups.find((g) => g.group_number === 2);
  assert.ok(group2);
  const board = (await s.admin.get(`/api/groups/${group2.id}/board`)).body;
  assert.deepEqual(board.tasks.map((t) => t.task_id), s.tasks.map((t) => t.id));
  assert.ok(board.tasks.every((t) => t.status === 'pending' && t.responsible === null));
  s.group2 = group2;
});

test('groups: numbering, membership rules and validation', async () => {
  // A student cannot be in two groups of the same project.
  const dup = await s.admin.post(`/api/projects/${s.project.id}/groups`, { student_ids: [s.users.s1.id] });
  assert.equal(dup.status, 409);
  // A group needs at least one student.
  assert.equal((await s.admin.post(`/api/projects/${s.project.id}/groups`, { student_ids: [] })).status, 400);
  assert.equal((await s.admin.put(`/api/groups/${s.group2.id}/students`, { student_ids: [] })).status, 400);
  // Only admins manage groups.
  assert.equal((await teacher.post(`/api/projects/${s.project.id}/groups`, { student_ids: [s.users.s4.id] })).status, 403);
  // The database itself also enforces one group per project and student.
  await assert.rejects(
    db.query('INSERT INTO group_students (group_id, project_id, user_id) VALUES (?, ?, ?)', [
      s.group1.id, s.project.id, s.users.s1.id,
    ]),
    { code: 'ER_DUP_ENTRY' }
  );
  // GitHub URL: only the group's students (or admins), and it must be a repository URL.
  assert.equal((await student1.put(`/api/groups/${s.group0.id}/github`, { github_url: 'https://github.com/org/repo' })).status, 200);
  assert.equal((await student1.put(`/api/groups/${s.group0.id}/github`, { github_url: 'https://evil.example/x' })).status, 400);
  assert.equal((await student3.put(`/api/groups/${s.group0.id}/github`, { github_url: 'https://github.com/a/b' })).status, 403);
  assert.equal((await teacher.put(`/api/groups/${s.group0.id}/github`, { github_url: 'https://github.com/a/b' })).status, 403);
  assert.equal((await teacher.get(`/api/groups/${s.group0.id}/board`)).body.group.github_url, 'https://github.com/org/repo');
});

test('10. modifying a shared task does not reset group progress', async () => {
  const gt = await groupTaskOf(student1, s.group0.id, s.tasks[0].id);
  await student1.post(`/api/group-tasks/${gt.id}/status`, { status: 'in_progress' });
  await student1.post(`/api/group-tasks/${gt.id}/comments`, { content: 'Working on it' });

  const edited = await teacher.put(`/api/tasks/${s.tasks[0].id}`, taskBody({ title: 'Task A (v2)', description: 'Changed' }));
  assert.equal(edited.body.version, 2);

  const after = (await student1.get(`/api/group-tasks/${gt.id}`)).body;
  assert.equal(after.title, 'Task A (v2)');
  assert.equal(after.status, 'in_progress');
  assert.equal(after.responsible.id, s.users.s1.id);
  assert.equal(after.comments.length, 1);
  assert.ok(after.history.some((h) => h.event_type === 'started'));
  // Other groups see the new definition and keep their own state.
  assert.equal((await groupTaskOf(student3, s.group1.id, s.tasks[0].id)).status, 'pending');
  assert.equal((await groupTaskOf(student3, s.group1.id, s.tasks[0].id)).title, 'Task A (v2)');
});

test('11 & 12. task order is global, and only administrators can reorder', async () => {
  const ids = s.tasks.map((t) => t.id);
  const reversed = [...ids].reverse();

  assert.equal((await teacher.put(`/api/projects/${s.project.id}/tasks/order`, { task_ids: reversed })).status, 403);
  assert.equal((await student1.put(`/api/projects/${s.project.id}/tasks/order`, { task_ids: reversed })).status, 403);
  // The order must contain exactly the project's tasks.
  assert.equal((await s.admin.put(`/api/projects/${s.project.id}/tasks/order`, { task_ids: ids.slice(1) })).status, 400);

  const res = await s.admin.put(`/api/projects/${s.project.id}/tasks/order`, { task_ids: reversed });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.map((t) => t.id), reversed);

  for (const group of [s.group0, s.group1, s.group2]) {
    const board = (await s.admin.get(`/api/groups/${group.id}/board`)).body;
    assert.deepEqual(board.tasks.map((t) => t.task_id), reversed, `group ${group.group_number}`);
  }
  const matrix = (await teacher.get(`/api/projects/${s.project.id}/matrix`)).body;
  assert.deepEqual(matrix.tasks.map((t) => t.id), reversed);

  // New tasks are appended at the end.
  const appended = (await s.admin.post(`/api/projects/${s.project.id}/tasks`, taskBody({ title: 'Last' }))).body;
  const list = (await s.admin.get(`/api/projects/${s.project.id}/tasks`)).body;
  assert.equal(list.at(-1).id, appended.id);

  // No priority concept anywhere in the schema.
  const columns = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME LIKE '%priorit%'"
  );
  assert.equal(columns.length, 0);
});

test('24. task definition versions are preserved', async () => {
  const taskId = s.tasks[2].id;
  await teacher.put(`/api/tasks/${taskId}`, taskBody({ title: 'Task C', description: 'Second text', module_ids: [s.modules.programming.id] }));
  // Saving identical content does not create a version.
  const same = await teacher.put(`/api/tasks/${taskId}`, taskBody({ title: 'Task C', description: 'Second text', module_ids: [s.modules.programming.id] }));
  assert.equal(same.body.version, 2);
  const third = await teacher.put(`/api/tasks/${taskId}`, taskBody({ title: 'Task C final', description: 'Second text', module_ids: [s.modules.programming.id] }));
  assert.equal(third.body.version, 3);

  const versions = (await teacher.get(`/api/tasks/${taskId}/versions`)).body;
  assert.deepEqual(versions.map((v) => v.version), [3, 2, 1]);
  assert.equal(versions[2].title, 'Task C');
  assert.equal(versions[2].description, 'Description of **Task C**');
  assert.deepEqual(versions[2].modules.map((m) => m.name).sort(), ['Databases', 'Programming']);
  assert.deepEqual(versions[1].modules.map((m) => m.name), ['Programming']);
  assert.equal(versions[0].modified_by_name, 'Teacher A');
});

test('tasks: module and markdown rules', async () => {
  // A task needs at least one module, and only modules of its project.
  assert.equal((await teacher.post(`/api/projects/${s.project.id}/tasks`, taskBody({ module_ids: [] }))).status, 400);
  const foreign = (await s.admin.post('/api/modules', { name: 'Networks', color: '#10b981' })).body;
  assert.equal((await teacher.post(`/api/projects/${s.project.id}/tasks`, taskBody({ module_ids: [foreign.id] }))).status, 400);

  // Markdown is rendered and sanitized.
  const created = await teacher.post(`/api/projects/${s.project.id}/tasks`, taskBody({
    title: 'XSS',
    description: '# Title\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1)) <img src="x" onerror="alert(1)">\n\n```js\nconst a = 1;\n```',
  }));
  const html = created.body.description_html;
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<pre><code/);
  assert.doesNotMatch(html, /<script|javascript:|onerror/);
});

test('22 & 23. markdown import: atomic, and only for projects without tasks', async () => {
  const markdown = `# Project Tasks

## Create GitHub Repository

**Modules:** Programming

### Description

Create the group's GitHub repository.

### Acceptance Criteria

- The repository exists.
- Every group member has access.

---

## Design Database

**Modules:** Databases, Programming

### Description

Create the relational database schema.

\`\`\`sql
## not a task heading
\`\`\`

### Acceptance Criteria

- Complete entity-relationship diagram.
`;

  // Not available once the project has tasks (backend enforced).
  const blocked = await s.admin.post(`/api/projects/${s.project.id}/import`, { markdown });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'import_not_available');
  assert.equal((await s.admin.post(`/api/projects/${s.project.id}/import/preview`, { markdown })).status, 409);

  const empty = (
    await s.admin.post('/api/projects', {
      name: 'Import target',
      academic_year: '2026-2027',
      module_ids: [s.modules.programming.id, s.modules.databases.id],
    })
  ).body;
  await s.admin.post(`/api/projects/${empty.id}/groups`, { student_ids: [s.users.s1.id] });
  await s.admin.post(`/api/projects/${empty.id}/groups`, { student_ids: [s.users.s2.id] });

  // Only administrators import.
  await s.admin.put(`/api/projects/${empty.id}/teachers`, { teacher_ids: [s.users.teacher.id] });
  assert.equal((await teacher.post(`/api/projects/${empty.id}/import`, { markdown })).status, 403);

  // 23. One bad task (unknown module) means nothing is created.
  const invalid = markdown.replace('**Modules:** Databases, Programming', '**Modules:** Databases, Astronomy');
  const preview = (await s.admin.post(`/api/projects/${empty.id}/import/preview`, { markdown: invalid })).body;
  assert.equal(preview.valid, false);
  assert.equal(preview.tasks.length, 2);
  assert.match(preview.errors.join(' '), /Astronomy/);
  const failed = await s.admin.post(`/api/projects/${empty.id}/import`, { markdown: invalid });
  assert.equal(failed.status, 422);
  assert.equal((await s.admin.get(`/api/projects/${empty.id}/tasks`)).body.length, 0);
  const leftovers = await db.query('SELECT COUNT(*) AS n FROM group_tasks WHERE project_id = ?', [empty.id]);
  assert.equal(leftovers[0].n, 0);

  // 22. A valid document imports in order, pending and unassigned, in every group.
  const okPreview = (await s.admin.post(`/api/projects/${empty.id}/import/preview`, { markdown })).body;
  assert.equal(okPreview.valid, true);
  assert.deepEqual(okPreview.tasks.map((t) => [t.order, t.title]), [[1, 'Create GitHub Repository'], [2, 'Design Database']]);

  const imported = await s.admin.post(`/api/projects/${empty.id}/import`, { markdown });
  assert.equal(imported.status, 201);
  assert.deepEqual(imported.body.map((t) => t.title), ['Create GitHub Repository', 'Design Database']);
  assert.deepEqual(imported.body[1].modules.map((m) => m.name), ['Databases', 'Programming']);
  assert.match(imported.body[1].description, /## not a task heading/);
  assert.match(imported.body[0].acceptance_criteria, /Every group member has access/);

  const project = (await s.admin.get(`/api/projects/${empty.id}`)).body;
  for (const group of project.groups) {
    const board = (await s.admin.get(`/api/groups/${group.id}/board`)).body;
    assert.deepEqual(board.tasks.map((t) => t.title), ['Create GitHub Repository', 'Design Database']);
    assert.ok(board.tasks.every((t) => t.status === 'pending' && t.responsible === null));
  }

  // A second import is refused.
  assert.equal((await s.admin.post(`/api/projects/${empty.id}/import`, { markdown })).status, 409);
  // The template is downloadable.
  const template = await s.admin.get(`/api/projects/${empty.id}/import/template`);
  assert.equal(template.status, 200);
  assert.match(template.text, /\*\*Modules:\*\*/);
});

test('25. project duplication excludes groups, memberships, progress and history', async () => {
  const res = await s.admin.post(`/api/projects/${s.project.id}/duplicate`, { name: 'Project Two', academic_year: '2027-2028' });
  assert.equal(res.status, 201);
  const copy = res.body;
  assert.notEqual(copy.id, s.project.id);
  assert.equal(copy.name, 'Project Two');
  assert.equal(copy.academic_year, '2027-2028');
  assert.equal(copy.status, 'active');
  assert.deepEqual(copy.groups, []);
  assert.deepEqual(copy.teachers, []);
  assert.deepEqual(copy.modules.map((m) => m.name), ['Databases', 'Programming']);

  const original = (await s.admin.get(`/api/projects/${s.project.id}/tasks`)).body;
  const copied = (await s.admin.get(`/api/projects/${copy.id}/tasks`)).body;
  assert.deepEqual(copied.map((t) => t.title), original.map((t) => t.title));
  assert.deepEqual(copied.map((t) => t.modules.map((m) => m.name)), original.map((t) => t.modules.map((m) => m.name)));
  assert.ok(copied.every((t) => t.version === 1));

  const counts = await db.query(
    `SELECT (SELECT COUNT(*) FROM group_tasks WHERE project_id = ?) AS group_tasks,
            (SELECT COUNT(*) FROM project_groups WHERE project_id = ?) AS project_groups,
            (SELECT COUNT(*) FROM group_students WHERE project_id = ?) AS students`,
    [copy.id, copy.id, copy.id]
  );
  assert.deepEqual({ ...counts[0] }, { group_tasks: 0, project_groups: 0, students: 0 });
  // The teacher of the original is not carried over.
  assert.equal((await teacher.get(`/api/projects/${copy.id}`)).status, 403);
  // Only admins duplicate.
  assert.equal((await teacher.post(`/api/projects/${s.project.id}/duplicate`, {})).status, 403);
});

test('26. archived projects cannot be modified through normal editing endpoints', async () => {
  const gt = await groupTaskOf(student1, s.group0.id, s.tasks[1].id);
  assert.equal((await teacher.post(`/api/projects/${s.project.id}/archive`)).status, 403);
  assert.equal((await s.admin.post(`/api/projects/${s.project.id}/archive`)).status, 200);

  const attempts = [
    s.admin.put(`/api/projects/${s.project.id}`, { name: 'X', academic_year: '2026-2027' }),
    s.admin.put(`/api/projects/${s.project.id}/teachers`, { teacher_ids: [] }),
    s.admin.post(`/api/projects/${s.project.id}/groups`, { student_ids: [s.users.s4.id] }),
    s.admin.put(`/api/groups/${s.group0.id}/students`, { student_ids: [s.users.s1.id] }),
    s.admin.post(`/api/projects/${s.project.id}/tasks`, taskBody()),
    teacher.put(`/api/tasks/${s.tasks[0].id}`, taskBody()),
    s.admin.del(`/api/tasks/${s.tasks[0].id}`),
    s.admin.put(`/api/projects/${s.project.id}/tasks/order`, { task_ids: s.tasks.map((t) => t.id) }),
    student1.post(`/api/group-tasks/${gt.id}/status`, { status: 'in_progress' }),
    student1.post(`/api/group-tasks/${gt.id}/comments`, { content: 'late' }),
    student1.post(`/api/group-tasks/${gt.id}/attachments`, { url: 'https://example.com' }),
    teacher.post(`/api/group-tasks/${gt.id}/responsible`, { user_id: s.users.s2.id }),
    student1.put(`/api/groups/${s.group0.id}/github`, { github_url: 'https://github.com/a/b' }),
  ];
  for (const [index, attempt] of attempts.entries()) {
    const res = await attempt;
    assert.equal(res.status, 409, `attempt ${index}`);
    assert.equal(res.body.error.code, 'project_archived');
  }

  // Still readable for historical consultation, with no transitions offered.
  const board = await student1.get(`/api/groups/${s.group0.id}/board`);
  assert.equal(board.status, 200);
  assert.ok(board.body.tasks.every((t) => t.allowed_transitions.length === 0));

  assert.equal((await s.admin.post(`/api/projects/${s.project.id}/unarchive`)).status, 200);
  assert.equal((await student1.post(`/api/group-tasks/${gt.id}/comments`, { content: 'back' })).status, 201);
});
