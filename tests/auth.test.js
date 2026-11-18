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
