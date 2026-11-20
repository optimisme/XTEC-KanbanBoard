// The real-time channel: who may open it, what it tells and to whom.
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';
import config from '../src/config/index.js';
import { attachRealtime } from '../src/realtime/hub.js';
import { createScenario, groupTaskOf, login, setup, teardown } from './helpers.js';

let s;
let server;
let closeRealtime;
let url;
let teacher;
let student1;
let student2;
let student3;
const sockets = [];

before(async () => {
  const app = await setup();
  s = await createScenario();
  server = http.createServer(app);
  closeRealtime = attachRealtime(server, app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `ws://127.0.0.1:${server.address().port}/ws`;
  teacher = await login(s.users.teacher.email);
  student1 = await login(s.users.s1.email);
  student2 = await login(s.users.s2.email);
  student3 = await login(s.users.s3.email);
});
after(async () => {
  for (const ws of sockets) ws.terminate();
  closeRealtime();
  await new Promise((resolve) => server.close(resolve));
  await teardown();
});

const cookieOf = (client) => client.loginResponse.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');

// Opens a socket and collects what arrives. `next(type)` waits for a message.
function connect(client, { origin = config.appUrl } = {}) {
  const headers = { Origin: origin };
  if (client) headers.Cookie = cookieOf(client);
  const ws = new WebSocket(url, { headers });
  sockets.push(ws);
  const inbox = [];
  const waiting = [];
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    const index = waiting.findIndex((w) => w.type === message.type);
    if (index === -1) inbox.push(message);
    else waiting.splice(index, 1)[0].resolve(message);
  });
  const next = (type, ms = 2000) =>
    new Promise((resolve, reject) => {
      const index = inbox.findIndex((m) => m.type === type);
      if (index !== -1) return resolve(inbox.splice(index, 1)[0]);
      const entry = { type, resolve };
      waiting.push(entry);
      return setTimeout(() => {
        if (!waiting.includes(entry)) return;
        waiting.splice(waiting.indexOf(entry), 1);
        reject(new Error(`no "${type}" message arrived`));
      }, ms);
    });
  const opened = new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('unexpected-response', (req, res) => reject(Object.assign(new Error('refused'), { status: res.statusCode })));
    ws.on('error', () => {});
  });
  const closedWith = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  const say = (message) => ws.send(JSON.stringify(message));
  return { ws, next, opened, closedWith, say, inbox };
}

async function join(client, groupId) {
  const socket = connect(client);
  await socket.opened;
  socket.say({ type: 'subscribe', group_id: groupId });
  socket.subscribed = await socket.next('subscribed');
  return socket;
}

const silent = (socket, type, ms = 300) =>
  socket.next(type, ms).then(() => assert.fail(`unexpected "${type}" message`), () => {});

test('the channel needs a signed-in session and our own origin', async () => {
  await assert.rejects(connect(null).opened, { status: 401 });
  await assert.rejects(connect(student1, { origin: 'https://evil.example' }).opened, { status: 403 });
  const socket = connect(student1);
  await socket.opened;
  assert.equal((await socket.next('ready')).type, 'ready');
  socket.ws.close();
});

test('a student can only follow the board of their own group', async () => {
  const socket = connect(student3);
  await socket.opened;
  socket.say({ type: 'subscribe', group_id: s.group0.id });
  assert.equal((await socket.next('denied')).group_id, s.group0.id);
  socket.say({ type: 'subscribe', group_id: s.group1.id });
  assert.equal((await socket.next('subscribed')).group_id, s.group1.id);
  socket.ws.close();
});

test('a change reaches everybody on that board and nobody else', async () => {
  const a = await join(student1, s.group0.id);
  const b = await join(student2, s.group0.id);
  const staff = await join(teacher, s.group0.id);
  const other = await join(student3, s.group1.id);

  const task = await groupTaskOf(student1, s.group0.id, s.tasks[0].id);
  const res = await student1.agent
    .post(`/api/group-tasks/${task.id}/status`)
    .set('X-CSRF-Token', student1.token)
    .set('X-Client-Id', 'tab-of-student-1')
    .send({ status: 'in_progress', expected_status: 'pending' });
  assert.equal(res.status, 200);

  for (const socket of [a, b, staff]) {
    const message = await socket.next('board_changed');
    assert.equal(message.task_id, task.id);
    assert.equal(message.actor_id, s.users.s1.id);
    // The tab that made the change recognises its own notice.
    assert.equal(message.origin, 'tab-of-student-1');
    // Only a notice: the board itself is read through the API.
    assert.deepEqual(Object.keys(message).sort(), ['actor_id', 'origin', 'task_id', 'type']);
  }
  await silent(other, 'board_changed');

  // A rejected change is not announced.
  assert.equal((await student2.post(`/api/group-tasks/${task.id}/status`, { status: 'in_progress', expected_status: 'pending' })).status, 409);
  await silent(b, 'board_changed');

  // A change to the shared tasks reaches every board of the project.
  assert.equal((await teacher.post(`/api/projects/${s.project.id}/tasks`, { title: 'Task D', description: 'New', tags: [] })).status, 201);
  await a.next('board_changed');
  await other.next('board_changed');
  for (const socket of [a, b, staff, other]) socket.ws.close();
});

test('people on a board see each other and each other\'s drags', async () => {
  const a = await join(student1, s.group0.id);
  assert.deepEqual(a.subscribed.people.map((p) => p.name), ['Student 1']);
  const b = await join(student2, s.group0.id);
  assert.deepEqual(b.subscribed.people.map((p) => p.name).sort(), ['Student 1', 'Student 2']);
  assert.equal((await a.next('presence')).people.length, 2);

  const task = await groupTaskOf(student1, s.group0.id, s.tasks[1].id);
  // The name is the server's, whatever the message claims.
  a.say({ type: 'drag', task_id: task.id, status: 'in_progress', user: { id: 999, name: 'Somebody else' } });
  const drag = await b.next('drag');
  assert.deepEqual(drag, {
    type: 'drag',
    user: { id: s.users.s1.id, name: 'Student 1', role: 'student' },
    task_id: task.id,
    status: 'in_progress',
  });
  await silent(a, 'drag');

  // Somebody arriving in the middle of a drag sees it.
  const late = await join(teacher, s.group0.id);
  assert.equal(late.subscribed.drags[0].task_id, task.id);

  // A drag ends when it is dropped, or when the tab goes away.
  a.say({ type: 'drag_end' });
  assert.equal((await b.next('drag_end')).user_id, s.users.s1.id);
  a.say({ type: 'drag', task_id: task.id, status: 'nonsense' });
  assert.equal((await b.next('drag')).status, null);
  a.ws.close();
  assert.equal((await b.next('drag_end')).user_id, s.users.s1.id);
  for (const socket of [b, late]) socket.ws.close();
});

test('the channel closes when access ends', async () => {
  // Hiding the project takes it away from its students at once.
  const hiddenFrom = await join(student1, s.group0.id);
  const staff = await join(teacher, s.group0.id);
  const body = { name: s.project.name, description: '', academic_year: s.project.academic_year };
  assert.equal((await teacher.put(`/api/projects/${s.project.id}`, { ...body, hidden: true })).status, 200);
  assert.equal(await hiddenFrom.closedWith, 4403);
  await staff.next('board_changed');
  assert.equal((await teacher.put(`/api/projects/${s.project.id}`, { ...body, hidden: false })).status, 200);
  staff.ws.close();

  // A disabled account.
  const disabled = await join(student2, s.group0.id);
  assert.equal((await s.admin.patch(`/api/users/${s.users.s2.id}`, { status: 'disabled' })).status, 200);
  assert.equal(await disabled.closedWith, 4403);

  // Signing out.
  const leaving = await join(student3, s.group1.id);
  assert.equal((await student3.post('/auth/logout')).status, 204);
  assert.equal(await leaving.closedWith, 4401);
});
