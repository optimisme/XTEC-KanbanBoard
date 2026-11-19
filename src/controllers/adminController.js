import * as userService from '../services/userService.js';
import * as v from '../validators/index.js';

// ---- Users ------------------------------------------------------------------

export async function listUsers(req, res) {
  res.json(await userService.list(req.query));
}

export async function createUser(req, res) {
  res.status(201).json(await userService.create(req.body));
}

export async function lookupStudent(req, res) {
  res.json(await userService.lookupPerson(req.body, 'student'));
}

export async function lookupTeacher(req, res) {
  res.json(await userService.lookupPerson(req.body, 'teacher'));
}

export async function suggestStudents(req, res) {
  res.json(await userService.suggestPeople(req.query, 'student'));
}

export async function suggestTeachers(req, res) {
  res.json(await userService.suggestPeople(req.query, 'teacher'));
}

export async function setPassword(req, res) {
  res.json(await userService.setOwnPassword(req.user, req.body, req.sessionID));
}

export async function clearPassword(req, res) {
  res.json(await userService.clearPassword(req.user, v.id(req.params.id), req.sessionID));
}

export async function deleteUser(req, res) {
  await userService.remove(req.user, v.id(req.params.id));
  res.status(204).end();
}

export async function updateUser(req, res) {
  res.json(await userService.update(req.user, v.id(req.params.id), req.body));
}

export async function approveUser(req, res) {
  const role = req.body.role || 'student';
  res.json(await userService.update(req.user, v.id(req.params.id), { status: 'active', role }));
}

export async function rejectUser(req, res) {
  res.json(await userService.update(req.user, v.id(req.params.id), { status: 'rejected' }));
}

export async function updateProfile(req, res) {
  res.json(await userService.updateOwnProfile(req.user, req.body));
}

