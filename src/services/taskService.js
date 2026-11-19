import { db } from '../db/pool.js';
import * as projectRepo from '../repositories/projectRepository.js';
import * as tagRepo from '../repositories/tagRepository.js';
import * as taskRepo from '../repositories/taskRepository.js';
import * as groupTaskRepo from '../repositories/groupTaskRepository.js';
import { badRequest, notFound } from '../utils/errors.js';
import { renderMarkdown } from '../utils/markdown.js';
import * as v from '../validators/index.js';
import { assertWritable, managerAccess, projectAccess } from './accessService.js';
import { resolveNames } from './tagService.js';

export function presentTask(task, tags, { html = false } = {}) {
  return {
    id: task.id,
    project_id: task.project_id,
    title: task.title,
    description: task.description,
    sort_order: task.sort_order,
    version: task.version,
    author: { id: task.author_id, name: task.author_name },
    tags,
    created_at: task.created_at,
    updated_at: task.updated_at,
    ...(html ? { description_html: renderMarkdown(task.description) } : {}),
  };
}

// `tags` is a list of tag names; a task may have none. Names that the project
// does not have yet are created when the task is saved.
function parseTask(body) {
  return {
    title: v.text(body.title, 'títol', { max: 200 }),
    description: v.text(body.description, 'descripció', { max: 100000, required: false }),
    tagNames: body.tags,
  };
}

const snapshot = (tags) => tags.map((tag) => ({ id: tag.id, name: tag.name }));

// Inserts one shared task and its instance in every existing group. Must run
// inside a transaction that holds the project lock.
export async function insertTask(t, { projectId, userId, data, tags, sortOrder }) {
  const taskId = await taskRepo.create(t, { projectId, ...data, sortOrder, authorId: userId });
  await tagRepo.setTaskTags(t, taskId, projectId, tags.map((tag) => tag.id));
  await taskRepo.insertVersion(t, { taskId, version: 1, ...data, tags: snapshot(tags), userId });
  await groupTaskRepo.createForTask(t, taskId, projectId);
  return taskId;
}

export async function list(user, projectId) {
  await projectAccess(db, user, projectId);
  const tasks = await taskRepo.listByProject(db, projectId);
  const tags = await tagRepo.mapForTasks(db, tasks.map((t) => t.id));
  return tasks.map((task) => presentTask(task, tags.get(task.id)));
}

async function loadTask(executor, taskId) {
  const task = await taskRepo.findById(executor, taskId);
  if (!task || task.deleted_at) throw notFound("No s'ha trobat la tasca.");
  return task;
}

export async function get(user, taskId) {
  const task = await loadTask(db, taskId);
  await projectAccess(db, user, task.project_id);
  const tags = await tagRepo.mapForTasks(db, [task.id]);
  return presentTask(task, tags.get(task.id), { html: true });
}

// New tasks are appended at the end of the global order and appear in every
// existing group as pending.
export async function create(user, projectId, body) {
  const data = parseTask(body);
  const taskId = await db.tx(async (t) => {
    const project = await projectRepo.lock(t, projectId);
    if (!project) throw notFound("No s'ha trobat el projecte.");
    await managerAccess(t, user, projectId);
    assertWritable(project);
    const tags = await resolveNames(t, projectId, data.tagNames);
    return insertTask(t, {
      projectId,
      userId: user.id,
      data,
      tags,
      sortOrder: await taskRepo.nextSortOrder(t, projectId),
    });
  });
  return get(user, taskId);
}

// Editing the shared definition never touches group progress. A new version
// is stored only when a meaningful field actually changed.
export async function update(user, taskId, body) {
  const data = parseTask(body);
  await db.tx(async (t) => {
    const existing = await loadTask(t, taskId);
    const project = await projectRepo.lock(t, existing.project_id);
    await managerAccess(t, user, existing.project_id);
    assertWritable(project);

    const task = await loadTask(t, taskId);
    const tags = await resolveNames(t, task.project_id, data.tagNames);
    const tagIds = tags.map((tag) => tag.id);
    const currentTagIds = (await tagRepo.mapForTasks(t, [taskId])).get(taskId).map((tag) => tag.id);
    const sameTags = currentTagIds.length === tagIds.length && currentTagIds.every((id) => tagIds.includes(id));
    const changed = task.title !== data.title || task.description !== data.description || !sameTags;
    if (!changed) return;

    const version = task.version + 1;
    await taskRepo.update(t, taskId, { ...data, version });
    await tagRepo.setTaskTags(t, taskId, task.project_id, tagIds);
    await taskRepo.insertVersion(t, { taskId, version, ...data, tags: snapshot(tags), userId: user.id });
  });
  return get(user, taskId);
}

// Soft deletion: the task disappears from boards, its history is kept.
export async function remove(user, taskId) {
  await db.tx(async (t) => {
    const task = await loadTask(t, taskId);
    const project = await projectRepo.lock(t, task.project_id);
    await managerAccess(t, user, task.project_id);
    assertWritable(project);
    await taskRepo.softDelete(t, taskId);
  });
}

// Administrators and the project's teachers define the global order shared
// by all groups. Students never do.
export async function reorder(user, projectId, body) {
  await managerAccess(db, user, projectId);
  const taskIds = v.idArray(body.task_ids, 'tasques');
  await db.tx(async (t) => {
    const project = await projectRepo.lock(t, projectId);
    if (!project) throw notFound("No s'ha trobat el projecte.");
    assertWritable(project);
    const current = (await taskRepo.listByProject(t, projectId)).map((task) => task.id);
    if (current.length !== taskIds.length || !current.every((id) => taskIds.includes(id))) {
      throw badRequest("L'ordre ha d'incloure exactament totes les tasques del projecte.");
    }
    for (let i = 0; i < taskIds.length; i += 1) await taskRepo.setSortOrder(t, taskIds[i], i + 1);
  });
  return list(user, projectId);
}

export async function versions(user, taskId) {
  const task = await loadTask(db, taskId);
  await managerAccess(db, user, task.project_id);
  const rows = await taskRepo.versions(db, taskId);
  return rows.map((row) => ({
    ...row,
    tags: typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags,
    description_html: renderMarkdown(row.description),
    current: row.version === task.version,
  }));
}
