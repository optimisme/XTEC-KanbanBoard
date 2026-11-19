import * as groupService from '../services/groupService.js';
import * as importService from '../services/importService.js';
import * as projectService from '../services/projectService.js';
import * as supervisionService from '../services/supervisionService.js';
import * as tagService from '../services/tagService.js';
import * as taskService from '../services/taskService.js';
import * as v from '../validators/index.js';

const projectId = (req) => v.id(req.params.projectId, 'projecte');
const groupId = (req) => v.id(req.params.groupId, 'grup');
const taskId = (req) => v.id(req.params.taskId, 'tasca');

// ---- Projects -----------------------------------------------------------------

export async function list(req, res) {
  res.json(await projectService.list(req.user));
}

export async function get(req, res) {
  res.json(await projectService.get(req.user, projectId(req)));
}

export async function create(req, res) {
  res.status(201).json(await projectService.create(req.user, req.body));
}

export async function update(req, res) {
  res.json(await projectService.update(req.user, projectId(req), req.body));
}

export async function remove(req, res) {
  await projectService.remove(req.user, projectId(req));
  res.status(204).end();
}

export async function archive(req, res) {
  res.json(await projectService.setStatus(req.user, projectId(req), 'archived'));
}

export async function unarchive(req, res) {
  res.json(await projectService.setStatus(req.user, projectId(req), 'active'));
}

export async function duplicate(req, res) {
  res.status(201).json(await projectService.duplicate(req.user, projectId(req), req.body));
}

export async function addTeacher(req, res) {
  res.status(201).json(await projectService.addTeacher(req.user, projectId(req), req.body));
}

export async function removeTeacher(req, res) {
  res.json(await projectService.removeTeacher(req.user, projectId(req), v.id(req.params.userId, 'professor')));
}

export async function setTeachers(req, res) {
  res.json(await projectService.setTeachers(req.user, projectId(req), req.body));
}

// ---- Tags -----------------------------------------------------------------------

export async function listTags(req, res) {
  res.json(await tagService.list(req.user, projectId(req)));
}

export async function tagSuggestions(req, res) {
  res.json(await tagService.suggestions(req.user, projectId(req)));
}

export async function createTag(req, res) {
  res.status(201).json(await tagService.create(req.user, projectId(req), req.body));
}

export async function updateTag(req, res) {
  res.json(await tagService.update(req.user, v.id(req.params.tagId, 'etiqueta'), req.body));
}

export async function deleteTag(req, res) {
  await tagService.remove(req.user, v.id(req.params.tagId, 'etiqueta'));
  res.status(204).end();
}

// ---- Groups ---------------------------------------------------------------------

export async function createGroup(req, res) {
  res.status(201).json(await groupService.create(req.user, projectId(req), req.body));
}

export async function setGroupStudents(req, res) {
  res.json(await groupService.setStudents(req.user, groupId(req), req.body));
}

export async function deleteGroup(req, res) {
  res.json(await groupService.remove(req.user, groupId(req)));
}

export async function setGithubUrl(req, res) {
  res.json(await groupService.setGithubUrl(req.user, groupId(req), req.body));
}

// ---- Shared task definitions ------------------------------------------------------

export async function listTasks(req, res) {
  res.json(await taskService.list(req.user, projectId(req)));
}

export async function createTask(req, res) {
  res.status(201).json(await taskService.create(req.user, projectId(req), req.body));
}

export async function reorderTasks(req, res) {
  res.json(await taskService.reorder(req.user, projectId(req), req.body));
}

export async function getTask(req, res) {
  res.json(await taskService.get(req.user, taskId(req)));
}

export async function updateTask(req, res) {
  res.json(await taskService.update(req.user, taskId(req), req.body));
}

export async function deleteTask(req, res) {
  await taskService.remove(req.user, taskId(req));
  res.status(204).end();
}

export async function taskVersions(req, res) {
  res.json(await taskService.versions(req.user, taskId(req)));
}

// ---- Markdown import ----------------------------------------------------------------

export async function importTemplate(req, res) {
  const markdown = await importService.template(req.user, projectId(req));
  res.set('Content-Type', 'text/markdown; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="plantilla-tasques.md"');
  res.send(markdown);
}

export async function importPreview(req, res) {
  res.json(await importService.preview(req.user, projectId(req), req.body));
}

export async function importTasks(req, res) {
  res.status(201).json(await importService.importTasks(req.user, projectId(req), req.body));
}

// ---- Supervision ----------------------------------------------------------------------

export async function matrix(req, res) {
  res.json(await supervisionService.matrix(req.user, projectId(req), req.query));
}

export async function blockedTasks(req, res) {
  res.json(await supervisionService.blocked(req.user));
}

export async function contributions(req, res) {
  res.json(await supervisionService.contributions(req.user, projectId(req), v.id(req.params.userId, 'alumne')));
}
