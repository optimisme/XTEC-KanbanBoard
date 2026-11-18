// Shared test harness. Tests run against the dedicated database configured in
// .env.test; the configuration refuses any DB_NAME that does not end in "_test".
import request from 'supertest';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { closePool, db, pool } from '../src/db/pool.js';

const TABLES = [
  'task_history', 'task_block_events', 'task_comments', 'group_tasks',
  'task_versions', 'task_modules', 'task_definitions', 'group_students', 'project_groups',
  'project_modules', 'project_teachers', 'projects', 'modules', 'users', 'sessions',
];

let app;

export async function setup() {
  await migrate({ log() {} });
  await resetDatabase();
  app = createApp();
  return app;
}

export async function teardown() {
  await app.locals.sessionStore.close();
  await closePool();
}

export async function resetDatabase() {
  const connection = await pool.getConnection();
  try {
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of TABLES) await connection.query(`TRUNCATE TABLE ${table}`);
    await connection.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally {
    connection.release();
  }
}

export { db };

export async function createUser({ email, name, role = 'student', status = 'active' }) {
  const result = await db.query(
    "INSERT INTO users (oidc_issuer, oidc_subject, email, name, role, status) VALUES ('dev-login', ?, ?, ?, ?, ?)",
    [email, email, name || email.split('@')[0], role, status]
  );
  return { id: result.insertId, email, role };
}

// Logs in through the development login and returns a small API client that
// keeps the session cookie and sends the CSRF token.
export async function login(email, name) {
  const agent = request.agent(app);
  const session = await agent.get('/api/session');
  const res = await agent.post('/auth/dev-login').set('X-CSRF-Token', session.body.csrf_token).send({ email, name });
  const token = res.body.csrf_token;
  const send = (method) => (url, body) => agent[method](url).set('X-CSRF-Token', token || '').send(body);
  return {
    loginResponse: res,
    agent,
    token,
    get: (url) => agent.get(url),
    post: send('post'),
    put: send('put'),
    patch: send('patch'),
    del: send('delete'),
  };
}

// A complete project: two modules, one assigned teacher, one unassigned
// teacher, two groups (students 1+2 and student 3) and three shared tasks.
export async function createScenario() {
  const users = {
    admin: await createUser({ email: 'admin@xtec.cat', name: 'Admin', role: 'admin' }),
    teacher: await createUser({ email: 'teacher@xtec.cat', name: 'Teacher A', role: 'teacher' }),
    otherTeacher: await createUser({ email: 'other@xtec.cat', name: 'Teacher B', role: 'teacher' }),
    s1: await createUser({ email: 's1@xtec.cat', name: 'Student 1' }),
    s2: await createUser({ email: 's2@xtec.cat', name: 'Student 2' }),
    s3: await createUser({ email: 's3@xtec.cat', name: 'Student 3' }),
    s4: await createUser({ email: 's4@xtec.cat', name: 'Student 4' }),
  };
  const admin = await login(users.admin.email);

  const programming = (await admin.post('/api/modules', { name: 'Programming', color: '#2563eb' })).body;
  const databases = (await admin.post('/api/modules', { name: 'Databases', color: '#fde68a' })).body;

  const project = (
    await admin.post('/api/projects', {
      name: 'Project One',
      description: 'A test project',
      academic_year: '2026-2027',
      module_ids: [programming.id, databases.id],
    })
  ).body;
  await admin.put(`/api/projects/${project.id}/teachers`, { teacher_ids: [users.teacher.id] });

  const tasks = [];
  for (const [title, moduleIds] of [
    ['Task A', [programming.id]],
    ['Task B', [databases.id]],
    ['Task C', [programming.id, databases.id]],
  ]) {
    const res = await admin.post(`/api/projects/${project.id}/tasks`, {
      title,
      description: `Description of **${title}**`,
      module_ids: moduleIds,
    });
    tasks.push(res.body);
  }

  await admin.post(`/api/projects/${project.id}/groups`, { student_ids: [users.s1.id, users.s2.id] });
  const detail = (await admin.post(`/api/projects/${project.id}/groups`, { student_ids: [users.s3.id] })).body;
  const [group0, group1] = detail.groups;

  return { users, admin, modules: { programming, databases }, project, tasks, group0, group1 };
}

// The group task of a shared task inside a group, looked up through the board.
export async function groupTaskOf(client, groupId, taskId) {
  const board = (await client.get(`/api/groups/${groupId}/board`)).body;
  return board.tasks.find((t) => t.task_id === taskId);
}
