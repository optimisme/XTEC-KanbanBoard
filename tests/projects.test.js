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
  tags: ['Programming'],
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

test('5. an assigned teacher manages every task regardless of its tags', async () => {
  // Task B is tagged only "Databases"; tags never affect what a teacher can do.
  const res = await teacher.put(`/api/tasks/${s.tasks[1].id}`, taskBody({ title: 'Task B', description: 'Edited by teacher', tags: ['Databases'] }));
  assert.equal(res.status, 200);
  assert.equal(res.body.description, 'Edited by teacher');

  const gt = await groupTaskOf(teacher, s.group1.id, s.tasks[1].id);
  assert.equal((await teacher.post(`/api/group-tasks/${gt.id}/status`, { status: 'in_progress' })).status, 200);
  assert.equal((await teacher.post(`/api/group-tasks/${gt.id}/status`, { status: 'pending' })).status, 200);

  const tables = await db.query(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND (TABLE_NAME LIKE 'teacher\\_%' OR TABLE_NAME LIKE '%module%')"
  );
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

test('groups: an optional short name next to the number', async () => {
  const members = { student_ids: [s.users.s4.id] };
  const groupOf = (res) => res.body.groups.find((g) => g.id === s.group2.id);
  assert.equal(s.group2.name, null);

  const named = await teacher.put(`/api/groups/${s.group2.id}/students`, { ...members, name: '  Els Pingüins ' });
  assert.equal(named.status, 200);
  assert.equal(groupOf(named).name, 'Els Pingüins');
  assert.equal(groupOf(named).group_number, 2);
  assert.equal((await s.admin.get(`/api/groups/${s.group2.id}/board`)).body.group.name, 'Els Pingüins');

  // Leaving the field out keeps the name; too long is rejected; empty removes it.
  assert.equal(groupOf(await teacher.put(`/api/groups/${s.group2.id}/students`, members)).name, 'Els Pingüins');
  assert.equal((await teacher.put(`/api/groups/${s.group2.id}/students`, { ...members, name: 'x'.repeat(41) })).status, 400);
  assert.equal((await teacher.put(`/api/groups/${s.group2.id}/students`, { ...members, name: 42 })).status, 400);
  assert.equal((await student1.put(`/api/groups/${s.group2.id}/students`, { ...members, name: 'Hacked' })).status, 403);
  assert.equal(groupOf(await teacher.put(`/api/groups/${s.group2.id}/students`, { ...members, name: '' })).name, null);
});

test('groups: numbering, membership rules and validation', async () => {
  // A student cannot be in two groups of the same project.
  const dup = await s.admin.post(`/api/projects/${s.project.id}/groups`, { student_ids: [s.users.s1.id] });
  assert.equal(dup.status, 409);
  // A group needs at least one student.
  assert.equal((await s.admin.post(`/api/projects/${s.project.id}/groups`, { student_ids: [] })).status, 400);
  assert.equal((await s.admin.put(`/api/groups/${s.group2.id}/students`, { student_ids: [] })).status, 400);
  // Groups are managed by admins and the project's teachers, nobody else.
  assert.equal((await otherTeacher.post(`/api/projects/${s.project.id}/groups`, { student_ids: [s.users.s4.id] })).status, 403);
  assert.equal((await student1.post(`/api/projects/${s.project.id}/groups`, { student_ids: [s.users.s4.id] })).status, 403);
  assert.equal((await otherTeacher.put(`/api/groups/${s.group2.id}/students`, { student_ids: [s.users.s4.id] })).status, 403);
  assert.equal((await otherTeacher.del(`/api/groups/${s.group2.id}`)).status, 403);
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

test('11 & 12. task order is global, and only project managers can reorder', async () => {
  const ids = s.tasks.map((t) => t.id);
  const reversed = [...ids].reverse();

  // Administrators and the project's own teachers reorder; nobody else.
  assert.equal((await otherTeacher.put(`/api/projects/${s.project.id}/tasks/order`, { task_ids: reversed })).status, 403);
  assert.equal((await student1.put(`/api/projects/${s.project.id}/tasks/order`, { task_ids: reversed })).status, 403);
  assert.equal((await teacher.put(`/api/projects/${s.project.id}/tasks/order`, { task_ids: ids })).status, 200);
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
  await teacher.put(`/api/tasks/${taskId}`, taskBody({ title: 'Task C', description: 'Second text', tags: ['Programming'] }));
  // Saving identical content does not create a version.
  const same = await teacher.put(`/api/tasks/${taskId}`, taskBody({ title: 'Task C', description: 'Second text', tags: ['Programming'] }));
  assert.equal(same.body.version, 2);
  const third = await teacher.put(`/api/tasks/${taskId}`, taskBody({ title: 'Task C final', description: 'Second text', tags: ['Programming'] }));
  assert.equal(third.body.version, 3);

  const versions = (await teacher.get(`/api/tasks/${taskId}/versions`)).body;
  assert.deepEqual(versions.map((v) => v.version), [3, 2, 1]);
  assert.equal(versions[2].title, 'Task C');
  assert.equal(versions[2].description, 'Description of **Task C**');
  assert.deepEqual(versions[2].tags.map((tag) => tag.name).sort(), ['Databases', 'Programming']);
  assert.deepEqual(versions[1].tags.map((tag) => tag.name), ['Programming']);
  assert.equal(versions[0].modified_by_name, 'Teacher A');
});

test('tasks: tag and markdown rules', async () => {
  const projectTagNames = async () => (await teacher.get(`/api/projects/${s.project.id}/tags`)).body.map((tag) => tag.name);

  // A task may have no tags at all.
  const bare = await teacher.post(`/api/projects/${s.project.id}/tasks`, taskBody({ title: 'No tags', tags: [] }));
  assert.equal(bare.status, 201);
  assert.deepEqual(bare.body.tags, []);
  assert.equal((await teacher.post(`/api/projects/${s.project.id}/tasks`, { title: 'No tags field' })).status, 201);

  // Unknown names become new tags of this project; known ones are reused whatever the letter case.
  const tagged = await teacher.post(`/api/projects/${s.project.id}/tasks`, taskBody({ title: 'Tagged', tags: ['programming', 'Networks', 'networks'] }));
  assert.deepEqual(tagged.body.tags.map((tag) => tag.name).sort(), ['Networks', 'Programming']);
  assert.deepEqual(await projectTagNames(), ['Databases', 'Networks', 'Programming']);
  assert.match(tagged.body.tags.find((tag) => tag.name === 'Networks').color, /^#[0-9a-f]{6}$/);

  // Validation.
  assert.equal((await teacher.post(`/api/projects/${s.project.id}/tasks`, taskBody({ tags: 'Programming' }))).status, 400);
  assert.equal((await teacher.post(`/api/projects/${s.project.id}/tasks`, taskBody({ tags: ['x'.repeat(41)] }))).status, 400);
  assert.equal((await teacher.post(`/api/projects/${s.project.id}/tasks`, taskBody({ tags: Array.from({ length: 13 }, (_, i) => `t${i}`) }))).status, 400);
  assert.deepEqual(await projectTagNames(), ['Databases', 'Networks', 'Programming']); // nothing created by failed requests

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
    })
  ).body;
  await s.admin.post(`/api/projects/${empty.id}/groups`, { student_ids: [s.users.s1.id] });
  await s.admin.post(`/api/projects/${empty.id}/groups`, { student_ids: [s.users.s2.id] });

  // Only the project's managers import.
  assert.equal((await otherTeacher.post(`/api/projects/${empty.id}/import`, { markdown })).status, 403);
  assert.equal((await teacher.post(`/api/projects/${empty.id}/import/preview`, { markdown })).status, 403);
  assert.equal((await student1.post(`/api/projects/${empty.id}/import`, { markdown })).status, 403);

  // 23. One bad task (a tag name that is too long) means nothing is created, not even tags.
  const invalid = markdown.replace('**Modules:** Databases, Programming', `**Tags:** Databases, ${'Astronomy'.repeat(6)}`);
  const preview = (await s.admin.post(`/api/projects/${empty.id}/import/preview`, { markdown: invalid })).body;
  assert.equal(preview.valid, false);
  assert.equal(preview.tasks.length, 2);
  assert.match(preview.errors.join(' '), /Astronomy/);
  const failed = await s.admin.post(`/api/projects/${empty.id}/import`, { markdown: invalid });
  assert.equal(failed.status, 422);
  assert.equal((await s.admin.get(`/api/projects/${empty.id}/tasks`)).body.length, 0);
  const leftovers = await db.query('SELECT COUNT(*) AS n FROM group_tasks WHERE project_id = ?', [empty.id]);
  assert.equal(leftovers[0].n, 0);
  assert.deepEqual((await s.admin.get(`/api/projects/${empty.id}/tags`)).body, []);

  // 22. A valid document imports in order, pending and unassigned, in every group.
  const okPreview = (await s.admin.post(`/api/projects/${empty.id}/import/preview`, { markdown })).body;
  assert.equal(okPreview.valid, true);
  assert.deepEqual(okPreview.tasks.map((t) => [t.order, t.title]), [[1, 'Create GitHub Repository'], [2, 'Design Database']]);

  const imported = await s.admin.post(`/api/projects/${empty.id}/import`, { markdown });
  assert.equal(imported.status, 201);
  assert.deepEqual(imported.body.map((t) => t.title), ['Create GitHub Repository', 'Design Database']);
  assert.deepEqual(imported.body[1].tags.map((tag) => tag.name), ['Databases', 'Programming']);
  // The import created the project's tags, reusing the colors those names have elsewhere.
  const importedTags = (await s.admin.get(`/api/projects/${empty.id}/tags`)).body;
  assert.deepEqual(importedTags.map((tag) => tag.name), ['Databases', 'Programming']);
  assert.equal(importedTags[1].color, s.tags.programming.color);
  assert.match(imported.body[1].description, /## not a task heading/);
  // Sections such as "Acceptance Criteria" are simply part of the description.
  assert.match(imported.body[0].description, /### Acceptance Criteria[\s\S]*Every group member has access/);

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
  assert.match(template.text, /\*\*Tags:\*\* Databases/);
  // The template is itself a valid import: its instruction line is skipped and
  // it shows tasks with one tag, two tags and no tags.
  const fresh = (await s.admin.post('/api/projects', { name: 'Template check', academic_year: '2026-2027' })).body;
  const ownTemplate = (await s.admin.get(`/api/projects/${fresh.id}/import/template`)).text;
  const templatePreview = (await s.admin.post(`/api/projects/${fresh.id}/import/preview`, { markdown: ownTemplate })).body;
  assert.equal(templatePreview.valid, true);
  assert.deepEqual(templatePreview.errors, []);
  assert.deepEqual(templatePreview.tasks.map((t) => t.tags.map((tag) => tag.name)), [['Programació'], ['Bases de dades', 'Programació'], []]);
  assert.ok(templatePreview.tasks[0].tags[0].is_new);
  assert.ok(templatePreview.tasks.every((t) => t.description.length > 0));
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
  // Tags are copied into the new project as its own tags (new ids, same names and colors).
  const sourceTags = (await s.admin.get(`/api/projects/${s.project.id}/tags`)).body;
  assert.deepEqual(copy.tags.map((tag) => [tag.name, tag.color]), sourceTags.map((tag) => [tag.name, tag.color]));
  assert.ok(copy.tags.every((tag) => !sourceTags.some((source) => source.id === tag.id)));

  const original = (await s.admin.get(`/api/projects/${s.project.id}/tasks`)).body;
  const copied = (await s.admin.get(`/api/projects/${copy.id}/tasks`)).body;
  assert.deepEqual(copied.map((t) => t.title), original.map((t) => t.title));
  assert.deepEqual(copied.map((t) => t.tags.map((tag) => tag.name)), original.map((t) => t.tags.map((tag) => tag.name)));
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
  // Unassigned teachers and students cannot duplicate.
  assert.equal((await otherTeacher.post(`/api/projects/${s.project.id}/duplicate`, {})).status, 403);
  assert.equal((await student1.post(`/api/projects/${s.project.id}/duplicate`, {})).status, 403);
  // A teacher who duplicates their project becomes the teacher of the copy.
  const mine = await teacher.post(`/api/projects/${s.project.id}/duplicate`, { name: 'Teacher copy', academic_year: '2027-2028' });
  assert.equal(mine.status, 201);
  assert.deepEqual(mine.body.teachers.map((t) => t.id), [s.users.teacher.id]);
  assert.deepEqual(mine.body.groups, []);
});

test('26. archived projects cannot be modified through normal editing endpoints', async () => {
  const gt = await groupTaskOf(student1, s.group0.id, s.tasks[1].id);
  assert.equal((await otherTeacher.post(`/api/projects/${s.project.id}/archive`)).status, 403);
  assert.equal((await student1.post(`/api/projects/${s.project.id}/archive`)).status, 403);
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

test('teachers create projects and manage them; teacher assignment stays with admins', async () => {
  const created = await teacher.post('/api/projects', {
    name: 'Teacher project', academic_year: '2026-2027',
  });
  assert.equal(created.status, 201);
  const projectId = created.body.id;
  assert.deepEqual(created.body.teachers.map((t) => t.id), [s.users.teacher.id]);
  assert.equal(created.body.can_manage, true);
  assert.ok((await teacher.get('/api/projects')).body.some((p) => p.id === projectId));

  // Students cannot create projects; other teachers cannot see or manage this one.
  assert.equal((await student1.post('/api/projects', { name: 'X', academic_year: '2026-2027' })).status, 403);
  assert.equal((await otherTeacher.get(`/api/projects/${projectId}`)).status, 403);
  assert.equal((await otherTeacher.put(`/api/projects/${projectId}`, { name: 'Y', academic_year: '2026-2027' })).status, 403);

  // The creator edits it, adds tasks, reorders, deletes and archives.
  assert.equal((await teacher.put(`/api/projects/${projectId}`, { name: 'Teacher project 2', academic_year: '2026-2027' })).body.name, 'Teacher project 2');
  const t1 = (await teacher.post(`/api/projects/${projectId}/tasks`, taskBody({ title: 'One' }))).body;
  const t2 = (await teacher.post(`/api/projects/${projectId}/tasks`, taskBody({ title: 'Two' }))).body;
  const order = await teacher.put(`/api/projects/${projectId}/tasks/order`, { task_ids: [t2.id, t1.id] });
  assert.deepEqual(order.body.map((t) => t.title), ['Two', 'One']);
  assert.equal((await teacher.del(`/api/tasks/${t1.id}`)).status, 204);
  assert.equal((await teacher.post(`/api/projects/${projectId}/archive`)).status, 200);
  assert.equal((await teacher.post(`/api/projects/${projectId}/unarchive`)).status, 200);

  // Replacing the list of teachers and managing users remain administrator tasks.
  assert.equal((await teacher.put(`/api/projects/${projectId}/teachers`, { teacher_ids: [s.users.otherTeacher.id] })).status, 403);
  assert.equal((await teacher.get('/api/users')).status, 403);
  s.teacherProjectId = projectId;
});

test('teachers add students to groups by email, creating accounts when needed', async () => {
  const projectId = s.teacherProjectId;
  const lookup = (client, email) => client.post('/api/students/lookup', { email });

  // Lookup: known student, unknown email, non-student, other domain, students not allowed.
  assert.deepEqual((await lookup(teacher, 'S1@xtec.cat')).body, { email: 's1@xtec.cat', found: true, id: s.users.s1.id, name: 'Student 1', problem: null });
  assert.deepEqual((await lookup(teacher, 'brand.new@xtec.cat')).body, { email: 'brand.new@xtec.cat', found: false });
  assert.match((await lookup(teacher, 'other@xtec.cat')).body.problem, /alumnat/);
  assert.equal((await lookup(teacher, 'someone@gmail.com')).status, 400);
  assert.equal((await lookup(student1, 's2@xtec.cat')).status, 403);

  // An unknown email needs a name; nothing is created without it.
  const missingName = await teacher.post(`/api/projects/${projectId}/groups`, { students: [{ email: 'brand.new@xtec.cat' }] });
  assert.equal(missingName.status, 400);
  assert.equal((await db.query("SELECT COUNT(*) AS n FROM users WHERE email = 'brand.new@xtec.cat'"))[0].n, 0);

  // Existing student + new student in one request.
  const created = await teacher.post(`/api/projects/${projectId}/groups`, {
    students: [{ email: 's1@xtec.cat' }, { email: 'Brand.New@xtec.cat', name: 'Brand New' }],
  });
  assert.equal(created.status, 201);
  const group = created.body.groups[0];
  assert.deepEqual(group.students.map((m) => m.name).sort(), ['Brand New', 'Student 1']);
  const [newUser] = await db.query("SELECT id, role, status, oidc_subject FROM users WHERE email = 'brand.new@xtec.cat'");
  assert.deepEqual({ role: newUser.role, status: newUser.status, subject: newUser.oidc_subject }, { role: 'student', status: 'active', subject: null });
  // The new group received the project's task.
  assert.equal((await teacher.get(`/api/groups/${group.id}/board`)).body.tasks.length, 1);

  // The new student signs in (verified email) and lands on their group, with no approval.
  const student = await login('brand.new@xtec.cat');
  assert.equal(student.loginResponse.body.user.status, 'active');
  assert.deepEqual((await student.get('/api/projects')).body.map((p) => p.my_group_id), [group.id]);

  // Rules: teachers, disabled accounts, other domains and repeated membership are refused; a failed request creates no account.
  const bad = async (students) => (await teacher.post(`/api/projects/${projectId}/groups`, { students })).status;
  assert.equal(await bad([{ email: 'other@xtec.cat' }]), 409);
  assert.equal(await bad([{ email: 'x@gmail.com', name: 'X' }]), 400);
  assert.equal(await bad([{ email: 's1@xtec.cat' }]), 409); // already in this project's group
  assert.equal(await bad([{ email: 'ghost@xtec.cat', name: 'Ghost' }, { email: 'other@xtec.cat' }]), 409);
  assert.equal((await db.query("SELECT COUNT(*) AS n FROM users WHERE email = 'ghost@xtec.cat'"))[0].n, 0);
  assert.equal(await bad([]), 400);

  // A pending account added to a group becomes an active student.
  await login('waiting@xtec.cat', 'Waiting Student');
  const edited = await teacher.put(`/api/groups/${group.id}/students`, {
    students: [{ email: 'brand.new@xtec.cat' }, { email: 'waiting@xtec.cat' }],
  });
  assert.equal(edited.status, 200);
  assert.deepEqual(edited.body.groups[0].students.map((m) => m.name).sort(), ['Brand New', 'Waiting Student']);
  assert.equal((await db.query("SELECT status FROM users WHERE email = 'waiting@xtec.cat'"))[0].status, 'active');
  // Student 1 was left out of the list, so they lost access to the group.
  assert.equal((await student1.get(`/api/groups/${group.id}/board`)).status, 403);

  // Outsiders still cannot touch the group.
  assert.equal((await otherTeacher.put(`/api/groups/${group.id}/students`, { students: [{ email: 's2@xtec.cat' }] })).status, 403);
  assert.equal((await student.put(`/api/groups/${group.id}/students`, { students: [{ email: 's2@xtec.cat' }] })).status, 403);
});

test('teachers add other teachers to their project by email', async () => {
  const projectId = s.teacherProjectId;
  const add = (client, email) => client.post(`/api/projects/${projectId}/teachers`, { email });

  // Outsiders and students cannot add anyone.
  assert.equal((await add(otherTeacher, 'other@xtec.cat')).status, 403);
  assert.equal((await add(student1, 'other@xtec.cat')).status, 403);

  // Lookup tells whether the email has an account and whether it can be used.
  const lookup = async (email) => (await teacher.post('/api/teachers/lookup', { email })).body;
  assert.deepEqual(await lookup('nobody.yet@xtec.cat'), { email: 'nobody.yet@xtec.cat', found: false });
  assert.equal((await lookup('other@xtec.cat')).problem, null);
  assert.match((await lookup('s2@xtec.cat')).problem, /professorat/);
  assert.equal((await student1.post('/api/teachers/lookup', { email: 'other@xtec.cat' })).status, 403);

  // An email without an account needs a name; nothing is created without it.
  assert.equal((await add(teacher, 'nobody.yet@xtec.cat')).status, 400);
  assert.equal((await db.query("SELECT COUNT(*) AS n FROM users WHERE email = 'nobody.yet@xtec.cat'"))[0].n, 0);
  // With a name, the teacher account is created and added to the project.
  const fresh = await teacher.post(`/api/projects/${projectId}/teachers`, { email: 'Nobody.Yet@xtec.cat', name: 'New Colleague' });
  assert.equal(fresh.status, 201);
  const [colleague] = await db.query("SELECT role, status, oidc_subject FROM users WHERE email = 'nobody.yet@xtec.cat'");
  assert.deepEqual({ ...colleague }, { role: 'teacher', status: 'active', oidc_subject: null });
  // They sign in later (verified email) and manage the project, with no approval.
  const colleagueClient = await login('nobody.yet@xtec.cat');
  assert.equal((await colleagueClient.get(`/api/projects/${projectId}`)).body.can_manage, true);

  // A student is never turned into a teacher; other domains are refused.
  assert.equal((await add(teacher, 's2@xtec.cat')).status, 409);
  assert.equal((await db.query("SELECT role FROM users WHERE email = 's2@xtec.cat'"))[0].role, 'student');
  assert.equal((await teacher.post(`/api/projects/${projectId}/teachers`, { email: 'x@gmail.com', name: 'X' })).status, 400);
  assert.equal((await add(teacher, 'not-an-email')).status, 400);

  // A pending account is approved as a teacher when added.
  await login('pending.prof@xtec.cat', 'Pending Prof');
  assert.equal((await add(teacher, 'pending.prof@xtec.cat')).status, 201);
  assert.deepEqual({ ...(await db.query("SELECT role, status FROM users WHERE email = 'pending.prof@xtec.cat'"))[0] }, { role: 'teacher', status: 'active' });

  const added = await add(teacher, 'Other@xtec.cat');
  assert.equal(added.status, 201);
  assert.deepEqual(added.body.teachers.map((t) => t.name).sort(), ['New Colleague', 'Pending Prof', 'Teacher A', 'Teacher B']);
  assert.equal((await add(teacher, 'other@xtec.cat')).status, 409); // already there

  // The added teacher now manages the project like any other teacher of it.
  assert.equal((await otherTeacher.get(`/api/projects/${projectId}`)).body.can_manage, true);
  assert.equal((await otherTeacher.post(`/api/projects/${projectId}/tasks`, taskBody({ title: 'By colleague' }))).status, 201);

  // A teacher of the project removes a colleague (their account is kept), but not themself.
  const remove = (client, userId) => client.del(`/api/projects/${projectId}/teachers/${userId}`);
  const [pendingProf] = await db.query("SELECT id FROM users WHERE email = 'pending.prof@xtec.cat'");
  assert.equal((await remove(student1, pendingProf.id)).status, 403);
  const removed = await remove(teacher, pendingProf.id);
  assert.equal(removed.status, 200);
  assert.ok(!removed.body.teachers.some((t) => t.id === pendingProf.id));
  assert.equal((await db.query('SELECT status FROM users WHERE id = ?', [pendingProf.id]))[0].status, 'active');
  assert.equal((await remove(teacher, pendingProf.id)).status, 404); // no longer on the project
  assert.equal((await remove(teacher, s.users.teacher.id)).status, 409); // cannot remove oneself
  // Someone removed loses access at once and cannot remove others any more.
  assert.equal((await remove(otherTeacher, s.users.teacher.id)).status, 200);
  assert.equal((await teacher.get(`/api/projects/${projectId}`)).status, 403);
  assert.equal((await remove(teacher, s.users.otherTeacher.id)).status, 403);
  // An administrator can remove anyone, and can still replace the whole list.
  assert.equal((await remove(s.admin, s.users.otherTeacher.id)).status, 200);
  assert.equal((await otherTeacher.get(`/api/projects/${projectId}`)).status, 403);
  assert.equal((await otherTeacher.put(`/api/projects/${projectId}/teachers`, { teacher_ids: [s.users.otherTeacher.id] })).status, 403);
  assert.equal((await s.admin.put(`/api/projects/${projectId}/teachers`, { teacher_ids: [s.users.teacher.id] })).status, 200);
  assert.equal((await teacher.get(`/api/projects/${projectId}`)).body.can_manage, true);
});

test('known emails are suggested to staff while adding students or teachers', async () => {
  const suggest = async (client, people, q) => client.get(`/api/${people}/suggest?q=${encodeURIComponent(q)}`);

  // By part of the email or of the name, active accounts of the right role only.
  const students = (await suggest(teacher, 'students', 's1@')).body;
  assert.deepEqual(students.map((p) => p.email), ['s1@xtec.cat']);
  assert.deepEqual(Object.keys(students[0]).sort(), ['email', 'id', 'name']);
  assert.ok((await suggest(teacher, 'students', 'student')).body.length >= 4);
  assert.ok((await suggest(teacher, 'students', 'student')).body.length <= 8);
  assert.ok((await suggest(teacher, 'students', 'student')).body.every((p) => /student/i.test(p.name + p.email)));
  assert.deepEqual((await suggest(teacher, 'teachers', 'teacher b')).body.map((p) => p.email), ['other@xtec.cat']);
  assert.deepEqual((await suggest(teacher, 'students', 'teacher')).body, []);

  // Suggestions start with the first character; nothing for an empty search. Wildcards are taken literally.
  assert.ok((await suggest(teacher, 'students', 's')).body.length > 0);
  assert.deepEqual((await suggest(teacher, 'students', '')).body, []);
  assert.deepEqual((await suggest(teacher, 'students', '  ')).body, []);
  assert.deepEqual((await suggest(teacher, 'students', '%%')).body, []);
  assert.deepEqual((await suggest(teacher, 'students', '__')).body, []);

  // Disabled accounts are not offered; students cannot list anyone.
  await s.admin.patch(`/api/users/${s.users.s4.id}`, { status: 'disabled' });
  assert.deepEqual((await suggest(teacher, 'students', 's4@')).body, []);
  await s.admin.patch(`/api/users/${s.users.s4.id}`, { status: 'active' });
  assert.equal((await suggest(student1, 'students', 's2')).status, 403);
  assert.equal((await suggest(student1, 'teachers', 'te')).status, 403);
});

test('administrators see every project and can delete archived ones permanently', async () => {
  // A project with real activity: tasks, a group, progress, a block, a comment.
  const project = (await teacher.post('/api/projects', { name: 'To delete', academic_year: '2026-2027' })).body;
  await teacher.post(`/api/projects/${project.id}/tasks`, taskBody({ title: 'Doomed', tags: ['Temporary'] }));
  const withGroup = (await teacher.post(`/api/projects/${project.id}/groups`, { students: [{ email: 's2@xtec.cat' }] })).body;
  const student2 = await login('s2@xtec.cat');
  const board = (await student2.get(`/api/groups/${withGroup.groups[0].id}/board`)).body;
  const gt = board.tasks[0].id;
  await student2.post(`/api/group-tasks/${gt}/status`, { status: 'in_progress' });
  await student2.post(`/api/group-tasks/${gt}/status`, { status: 'blocked', reason: 'stuck' });
  await student2.post(`/api/group-tasks/${gt}/comments`, { content: 'help' });
  await teacher.post(`/api/projects/${project.id}/archive`);

  // Administrators list every project, active and archived, assigned or not.
  const all = (await s.admin.get('/api/projects')).body;
  const total = (await db.query('SELECT COUNT(*) AS n FROM projects'))[0].n;
  assert.equal(all.length, total);
  assert.equal(all.find((p) => p.id === project.id).status, 'archived');

  // An active project cannot be deleted, not even by an administrator: archive first.
  const del = (client) => client.del(`/api/projects/${project.id}`);
  await teacher.post(`/api/projects/${project.id}/unarchive`);
  const active = await del(s.admin);
  assert.equal(active.status, 409);
  assert.equal(active.body.error.code, 'project_not_archived');
  assert.equal((await s.admin.get(`/api/projects/${project.id}`)).status, 200);
  await teacher.post(`/api/projects/${project.id}/archive`);

  // Only administrators delete.
  assert.equal((await del(teacher)).status, 403);
  assert.equal((await del(student1)).status, 403);
  assert.equal((await s.admin.get(`/api/projects/${project.id}`)).status, 200);

  const usersBefore = (await db.query('SELECT COUNT(*) AS n FROM users'))[0].n;
  const otherTasksBefore = (await db.query('SELECT COUNT(*) AS n FROM group_tasks WHERE project_id = ?', [s.project.id]))[0].n;
  assert.equal((await del(s.admin)).status, 204);

  // Everything of that project is gone ...
  assert.equal((await s.admin.get(`/api/projects/${project.id}`)).status, 404);
  const [left] = await db.query(
    `SELECT (SELECT COUNT(*) FROM projects WHERE id = ?) + (SELECT COUNT(*) FROM project_groups WHERE project_id = ?)
          + (SELECT COUNT(*) FROM group_tasks WHERE project_id = ?) + (SELECT COUNT(*) FROM task_definitions WHERE project_id = ?)
          + (SELECT COUNT(*) FROM project_tags WHERE project_id = ?) + (SELECT COUNT(*) FROM project_teachers WHERE project_id = ?)
          + (SELECT COUNT(*) FROM task_history WHERE group_task_id = ?) + (SELECT COUNT(*) FROM task_comments WHERE group_task_id = ?)
          + (SELECT COUNT(*) FROM task_block_events WHERE group_task_id = ?) AS n`,
    [project.id, project.id, project.id, project.id, project.id, project.id, gt, gt, gt]
  );
  assert.equal(Number(left.n), 0);
  // ... while accounts and other projects are untouched.
  assert.equal((await db.query('SELECT COUNT(*) AS n FROM users'))[0].n, usersBefore);
  assert.equal((await db.query('SELECT COUNT(*) AS n FROM group_tasks WHERE project_id = ?', [s.project.id]))[0].n, otherTasksBefore);
  assert.equal((await student2.get('/api/projects')).body.some((p) => p.id === project.id), false);
  assert.equal((await del(s.admin)).status, 404);
});
