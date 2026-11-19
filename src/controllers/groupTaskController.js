import * as groupTaskService from '../services/groupTaskService.js';
import * as v from '../validators/index.js';

const groupTaskId = (req) => v.id(req.params.groupTaskId, 'tasca');

export async function board(req, res) {
  res.json(await groupTaskService.board(req.user, v.id(req.params.groupId, 'grup')));
}

export async function detail(req, res) {
  res.json(await groupTaskService.detail(req.user, groupTaskId(req)));
}

export async function changeStatus(req, res) {
  res.json(await groupTaskService.changeStatus(req.user, groupTaskId(req), req.body));
}

export async function transferResponsibility(req, res) {
  res.json(await groupTaskService.transferResponsibility(req.user, groupTaskId(req), req.body));
}

export async function addCollaborator(req, res) {
  res.status(201).json(await groupTaskService.addCollaborator(req.user, groupTaskId(req), req.body));
}

export async function removeCollaborator(req, res) {
  res.json(await groupTaskService.removeCollaborator(req.user, groupTaskId(req), v.id(req.params.userId, 'col·laborador')));
}

export async function addComment(req, res) {
  res.status(201).json(await groupTaskService.addComment(req.user, groupTaskId(req), req.body));
}

export async function history(req, res) {
  res.json(await groupTaskService.history(req.user, groupTaskId(req)));
}

