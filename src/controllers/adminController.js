import * as moduleService from '../services/moduleService.js';
import * as userService from '../services/userService.js';
import * as v from '../validators/index.js';

// ---- Users ------------------------------------------------------------------

export async function listUsers(req, res) {
  res.json(await userService.list(req.query));
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

// ---- Professional modules -----------------------------------------------------

export async function listModules(req, res) {
  res.json(await moduleService.list());
}

export async function createModule(req, res) {
  res.status(201).json(await moduleService.create(req.body));
}

export async function updateModule(req, res) {
  res.json(await moduleService.update(v.id(req.params.id), req.body));
}

export async function deleteModule(req, res) {
  await moduleService.remove(v.id(req.params.id));
  res.status(204).end();
}
