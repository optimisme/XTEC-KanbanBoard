import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import request from 'supertest';
import { identityFromClaims } from '../src/auth/oidc.js';
import { loginWithIdentity } from '../src/services/authService.js';
import { createUser, login, setup, teardown } from './helpers.js';

let app;
before(async () => {
  app = await setup();
});
after(teardown);

test('1. institutional login creates pending users', async () => {
  const user = await loginWithIdentity({
    issuer: 'https://accounts.google.com',
    subject: 'google-sub-1',
    email: 'New.Student@xtec.cat',
    emailVerified: true,
    name: 'New Student',
  });
  assert.equal(user.status, 'pending');
  assert.equal(user.email, 'new.student@xtec.cat');

  // The same identity logging in again is recognised, not duplicated.
  const again = await loginWithIdentity({
    issuer: 'https://accounts.google.com',
    subject: 'google-sub-1',
    email: 'new.student@xtec.cat',
    emailVerified: true,
    name: 'New Student',
  });
  assert.equal(again.id, user.id);
});

test('login rejects other domains, unverified emails and identity conflicts', async () => {
  const base = { issuer: 'https://accounts.google.com', emailVerified: true, name: 'X' };
  await assert.rejects(loginWithIdentity({ ...base, subject: 'a', email: 'someone@gmail.com' }), { code: 'domain_not_allowed' });
  await assert.rejects(loginWithIdentity({ ...base, subject: 'b', email: 'x@evil-xtec.cat' }), { code: 'domain_not_allowed' });
  await assert.rejects(
    loginWithIdentity({ ...base, subject: 'c', email: 'x@xtec.cat', emailVerified: false }),
    { code: 'email_not_verified' }
  );
  // Same email arriving with a different subject must not take over the account.
  await assert.rejects(
    loginWithIdentity({ ...base, subject: 'google-sub-other', email: 'new.student@xtec.cat' }),
    { code: 'identity_conflict' }
  );
});

test('identity claims: Google requires a verified email and an allowed hosted domain', () => {
  const claims = { iss: 'https://accounts.google.com', sub: '1', email: 'a@xtec.cat', email_verified: true, hd: 'xtec.cat' };
  assert.equal(identityFromClaims(claims).emailVerified, true);
  assert.equal(identityFromClaims({ ...claims, email_verified: false }).emailVerified, false);
  assert.equal(identityFromClaims({ ...claims, hd: 'other.org' }).emailVerified, false);
});

test('2. pending users cannot access project data', async () => {
  const pending = await login('pending@xtec.cat', 'Pending User');
  assert.equal(pending.loginResponse.status, 200);
  assert.equal(pending.loginResponse.body.user.status, 'pending');

  for (const url of ['/api/projects', '/api/projects/1', '/api/groups/1/board', '/api/modules', '/api/blocked-tasks']) {
    const res = await pending.get(url);
    assert.equal(res.status, 403, url);
    assert.equal(res.body.error.code, 'account_pending');
  }
});

test('unauthenticated requests are rejected', async () => {
  const res = await request(app).get('/api/projects');
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'unauthenticated');
});

test('3. administrators can approve users (and others cannot)', async () => {
  await createUser({ email: 'admin@xtec.cat', role: 'admin' });
  const admin = await login('admin@xtec.cat');
  const pendingList = (await admin.get('/api/users?status=pending')).body;
  const target = pendingList.find((u) => u.email === 'pending@xtec.cat');
  assert.ok(target);

  // A pending user cannot approve themselves.
  const pending = await login('pending@xtec.cat');
  assert.equal((await pending.post(`/api/users/${target.id}/approve`, { role: 'admin' })).status, 403);

  const approved = await admin.post(`/api/users/${target.id}/approve`, { role: 'teacher' });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, 'active');
  assert.equal(approved.body.role, 'teacher');
  assert.equal((await pending.get('/api/projects')).status, 200);

  // Teachers cannot manage users.
  assert.equal((await pending.get('/api/users')).status, 403);
});

test('disabled and rejected users lose access immediately', async () => {
  const admin = await login('admin@xtec.cat');
  const user = await createUser({ email: 'gone@xtec.cat' });
  const client = await login('gone@xtec.cat');
  assert.equal((await client.get('/api/projects')).status, 200);

  await admin.patch(`/api/users/${user.id}`, { status: 'disabled' });
  assert.equal((await client.get('/api/projects')).body.error.code, 'account_disabled');
  await admin.patch(`/api/users/${user.id}`, { status: 'rejected' });
  assert.equal((await client.get('/api/projects')).body.error.code, 'account_rejected');
});

test('state-changing requests need a valid CSRF token', async () => {
  const admin = await login('admin@xtec.cat');
  const res = await admin.agent.post('/api/modules').send({ name: 'X', color: '#000000' });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'invalid_csrf_token');
});

test('logout ends the session and login regenerates the session id', async () => {
  const agent = request.agent(app);
  const before = await agent.get('/api/session');
  const cookieBefore = before.headers['set-cookie'][0].split(';')[0];
  const res = await agent.post('/auth/dev-login').set('X-CSRF-Token', before.body.csrf_token).send({ email: 'admin@xtec.cat' });
  const cookieAfter = res.headers['set-cookie'][0].split(';')[0];
  assert.notEqual(cookieBefore, cookieAfter);

  assert.equal((await agent.post('/auth/logout').set('X-CSRF-Token', res.body.csrf_token)).status, 204);
  assert.equal((await agent.get('/api/projects')).status, 401);
});

test('administrator password login from .env', async () => {
  const agent = request.agent(app);
  const session = await agent.get('/api/session');
  assert.equal(session.body.admin_login, true);
  const post = (body, token = session.body.csrf_token) =>
    agent.post('/auth/admin-login').set('X-CSRF-Token', token).send(body);

  // Needs the CSRF token, and rejects wrong or malformed credentials.
  assert.equal((await agent.post('/auth/admin-login').send({ username: 'admin', password: 'test-admin-password' })).status, 403);
  assert.equal((await post({ username: 'admin', password: 'wrong' })).status, 401);
  assert.equal((await post({ username: 'other', password: 'test-admin-password' })).status, 401);
  assert.equal((await post({ username: { $ne: '' }, password: ['x'] })).status, 401);

  const ok = await post({ username: 'admin', password: 'test-admin-password' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.role, 'admin');
  assert.equal(ok.body.user.status, 'active');
  assert.equal((await agent.get('/api/users')).status, 200);

  // Logging in again reuses the same account.
  const again = await login('admin@xtec.cat');
  const locals = (await again.get('/api/users')).body.filter((u) => u.email === 'admin@local.invalid');
  assert.equal(locals.length, 1);
});

test('administrator login is locked after repeated failures', async () => {
  const agent = request.agent(app);
  const session = await agent.get('/api/session');
  const post = (password) =>
    agent.post('/auth/admin-login').set('X-CSRF-Token', session.body.csrf_token).send({ username: 'admin', password });

  for (let i = 0; i < 5; i += 1) assert.equal((await post('wrong')).status, 401);
  assert.equal((await post('wrong')).status, 429);
  // Even the right password is refused while the address is locked.
  const locked = await post('test-admin-password');
  assert.equal(locked.status, 429);
  assert.equal(locked.body.error.code, 'too_many_attempts');
});

test('users added in advance by email sign in without approval', async () => {
  const admin = await login('admin@xtec.cat');
  const created = await admin.post('/api/users', { name: 'Pre Teacher', email: 'Pre.Teacher@xtec.cat', role: 'teacher' });
  assert.equal(created.status, 201);
  assert.equal(created.body.email, 'pre.teacher@xtec.cat');
  assert.equal(created.body.status, 'active');
  assert.equal(created.body.role, 'teacher');
  assert.equal(created.body.last_login_at, null);

  // Validation: duplicates, other domains, bad emails, bad roles, non-admins.
  assert.equal((await admin.post('/api/users', { name: 'Again', email: 'pre.teacher@xtec.cat', role: 'student' })).status, 409);
  assert.equal((await admin.post('/api/users', { name: 'Out', email: 'someone@gmail.com', role: 'teacher' })).status, 400);
  assert.equal((await admin.post('/api/users', { name: 'Bad', email: 'not-an-email', role: 'teacher' })).status, 400);
  assert.equal((await admin.post('/api/users', { name: 'Bad', email: 'x@xtec.cat', role: 'owner' })).status, 400);
  assert.equal((await admin.post('/api/users', { name: '', email: 'y@xtec.cat', role: 'teacher' })).status, 400);
  const teacher = await login('pending@xtec.cat'); // approved as a teacher earlier
  assert.equal((await teacher.post('/api/users', { name: 'X', email: 'z@xtec.cat', role: 'admin' })).status, 403);

  // First institutional login: recognised by the verified email, already active.
  const first = await loginWithIdentity({
    issuer: 'https://accounts.google.com', subject: 'google-pre-teacher', email: 'pre.teacher@xtec.cat',
    emailVerified: true, name: 'Name From Google',
  });
  assert.equal(first.status, 'active');
  assert.equal(first.role, 'teacher');
  assert.equal(first.name, 'Pre Teacher'); // the name the administrator gave is kept
  assert.ok(first.last_login_at);

  // An unverified email never claims a pre-created account.
  await admin.post('/api/users', { name: 'Other', email: 'other.person@xtec.cat', role: 'teacher' });
  await assert.rejects(
    loginWithIdentity({ issuer: 'https://accounts.google.com', subject: 's2', email: 'other.person@xtec.cat', emailVerified: false, name: 'X' }),
    { code: 'email_not_verified' }
  );
});
