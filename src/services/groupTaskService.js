import { db } from '../db/pool.js';
import * as groupRepo from '../repositories/groupRepository.js';
import * as groupTaskRepo from '../repositories/groupTaskRepository.js';
import * as tagRepo from '../repositories/tagRepository.js';
import * as taskRepo from '../repositories/taskRepository.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors.js';
import { renderMarkdown } from '../utils/markdown.js';
import * as v from '../validators/index.js';
import { assertWritable, groupAccess, groupTaskAccess, groupTaskAccessById } from './accessService.js';

export const STATUSES = ['pending', 'in_progress', 'blocked', 'completed'];

// Transition policy. This is the single source of truth: the API also sends
// the allowed targets of each task to the frontend, which only offers those.
const STUDENT_TRANSITIONS = {
  pending: ['in_progress'],
  in_progress: ['pending', 'blocked', 'completed'],
  blocked: ['in_progress'],
  completed: ['in_progress'],
};

export function allowedTransitions(access, status) {
  if (access.project.status === 'archived') return [];
  // Teachers and administrators can correct a task to any other state.
  if (access.canManage) return STATUSES.filter((s) => s !== status);
  return STUDENT_TRANSITIONS[status];
}

function historyEvent(from, to) {
  if (to === 'completed') return 'completed';
  if (from === 'completed') return 'reopened';
  if (to === 'blocked') return 'blocked';
  if (from === 'blocked') return 'unblocked';
  if (from === 'pending' && to === 'in_progress') return 'started';
  return 'state_changed';
}

function presentCard(row, tags, collaborators, access, user) {
  const writable = access.project.status !== 'archived';
  const isResponsible = row.responsible_user_id !== null && row.responsible_user_id === user.id;
  return {
    id: row.id,
    group_id: row.group_id,
    task_id: row.task_id,
    title: row.title,
    sort_order: row.sort_order,
    tags,
    status: row.status,
    responsible: row.responsible_user_id ? { id: row.responsible_user_id, name: row.responsible_name } : null,
    collaborators,
    assigned_at: row.assigned_at,
    completed_at: row.completed_at,
    completed_by: row.completed_by ? { id: row.completed_by, name: row.completed_by_name } : null,
    completed_version: row.completed_version,
    block_reason: row.block_reason,
    blocked_at: row.blocked_at,
    comment_count: row.comment_count,
    allowed_transitions: allowedTransitions(access, row.status),
    can_transfer: writable && (access.canManage || isResponsible),
    // Collaborators only exist on a task that has a responsible student.
    can_edit_collaborators: writable && row.responsible_user_id !== null && (access.canManage || isResponsible),
  };
}

export async function board(user, groupId) {
  const access = await groupAccess(db, user, groupId);
  const [rows, members] = await Promise.all([groupTaskRepo.board(db, groupId), groupRepo.members(db, groupId)]);
  const tags = await tagRepo.mapForTasks(db, rows.map((r) => r.task_id));
  const collaborators = await groupTaskRepo.collaboratorsFor(db, rows.map((r) => r.id));
  return {
    project: {
      id: access.project.id,
      name: access.project.name,
      status: access.project.status,
      // Students read the project description from their board.
      description_html: renderMarkdown(access.project.description),
    },
    group: access.group,
    access: access.level,
    can_manage: access.canManage,
    members,
    tasks: rows.map((row) => presentCard(row, tags.get(row.task_id), collaborators.get(row.id), access, user)),
  };
}

export async function detail(user, groupTaskId) {
  const access = await groupTaskAccessById(db, user, groupTaskId);
  const row = await groupTaskRepo.findDetailed(db, groupTaskId);
  if (row.deleted_at) throw notFound("No s'ha trobat la tasca.");

  const [definition, tags, collaborators, members, comments, blockEvents, history] = await Promise.all([
    taskRepo.findById(db, row.task_id),
    tagRepo.mapForTasks(db, [row.task_id]),
    groupTaskRepo.collaboratorsFor(db, [groupTaskId]),
    groupRepo.members(db, row.group_id),
    groupTaskRepo.comments(db, groupTaskId),
    groupTaskRepo.blockEvents(db, groupTaskId),
    groupTaskRepo.history(db, groupTaskId),
  ]);

  return {
    ...presentCard(row, tags.get(row.task_id), collaborators.get(groupTaskId), access, user),
    project: { id: access.project.id, name: access.project.name, status: access.project.status },
    group: { id: access.group.id, group_number: access.group.group_number },
    access: access.level,
    can_manage: access.canManage,
    can_contribute: access.project.status !== 'archived',
    members,
    definition: {
      id: definition.id,
      version: definition.version,
      description: definition.description,
      description_html: renderMarkdown(definition.description),
      updated_at: definition.updated_at,
    },
    comments,
    block_events: blockEvents,
    history,
  };
}

// Locks the task row and resolves the caller's access inside a transaction.
async function lockForWrite(t, user, groupTaskId) {
  const groupTask = await groupTaskRepo.lock(t, groupTaskId);
  const access = await groupTaskAccess(t, user, groupTask);
  const definition = await taskRepo.findById(t, groupTask.task_id);
  if (definition.deleted_at) throw notFound("No s'ha trobat la tasca.");
  assertWritable(access.project);
  return { groupTask, access, definition };
}

// Changes the state of a group task. The row lock makes the state change and
// the automatic assignment a single atomic step, so two students starting the
// same task at the same time cannot both become responsible.
export async function changeStatus(user, groupTaskId, body) {
  const target = v.oneOf(body.status, 'estat', STATUSES);
  const expected = body.expected_status ? v.oneOf(body.expected_status, 'estat esperat', STATUSES) : null;
  const reason = target === 'blocked' ? v.text(body.reason, 'motiu del bloqueig', { max: 2000 }) : null;

  await db.tx(async (t) => {
    const { groupTask, access, definition } = await lockForWrite(t, user, groupTaskId);
    const from = groupTask.status;

    if (expected && expected !== from) {
      throw conflict("Algú altre ha modificat la tasca. S'ha actualitzat el tauler.", 'stale_task');
    }
    if (!allowedTransitions(access, from).includes(target)) {
      throw conflict("Aquest canvi d'estat no és permès.", 'invalid_transition');
    }

    const fields = { status: target };
    if (target === 'completed') {
      // Who completes is recorded separately from who is responsible.
      fields.completed_at = new Date();
      fields.completed_by = user.id;
      fields.completed_version = definition.version;
    } else if (from === 'completed') {
      fields.completed_at = null;
      fields.completed_by = null;
      fields.completed_version = null;
    }

    const autoAssign =
      access.level === 'student' && target === 'in_progress' && groupTask.responsible_user_id === null;
    if (autoAssign) {
      fields.responsible_user_id = user.id;
      fields.assigned_at = new Date();
    }

    await groupTaskRepo.update(t, groupTaskId, fields);

    if (from === 'blocked') {
      await groupTaskRepo.closeBlock(t, { groupTaskId, userId: user.id });
      await groupTaskRepo.addComment(t, { groupTaskId, authorId: user.id, content: '', type: 'unblock' });
    }
    if (target === 'blocked') {
      await groupTaskRepo.openBlock(t, { groupTaskId, reason, userId: user.id });
      await groupTaskRepo.addComment(t, { groupTaskId, authorId: user.id, content: reason, type: 'block' });
    }

    await groupTaskRepo.addHistory(t, {
      groupTaskId,
      actorId: user.id,
      eventType: historyEvent(from, target),
      oldValue: from,
      newValue: target,
    });
    if (autoAssign) {
      await groupTaskRepo.addHistory(t, { groupTaskId, actorId: user.id, eventType: 'auto_assigned', newValue: user.id });
    }
  });
  return detail(user, groupTaskId);
}

// Transfers responsibility. Students can only hand over their own tasks, and
// only to a member of the same group; teachers and admins can also unassign.
export async function transferResponsibility(user, groupTaskId, body) {
  const newUserId = v.optionalId(body.user_id, 'responsable');

  await db.tx(async (t) => {
    const { groupTask, access } = await lockForWrite(t, user, groupTaskId);
    const current = groupTask.responsible_user_id;

    if (!access.canManage) {
      if (current !== user.id) throw forbidden('Només la persona responsable pot transferir la tasca.');
      if (newUserId === null) throw badRequest('Cal indicar la nova persona responsable.');
    }
    if (newUserId === current) throw badRequest('Aquesta persona ja és la responsable de la tasca.');
    if (newUserId !== null && !(await groupRepo.isMember(t, groupTask.group_id, newUserId))) {
      throw badRequest('La nova persona responsable ha de ser membre del grup.');
    }

    await groupTaskRepo.update(t, groupTaskId, {
      responsible_user_id: newUserId,
      assigned_at: newUserId === null ? null : new Date(),
    });
    await groupTaskRepo.addHistory(t, {
      groupTaskId,
      actorId: user.id,
      eventType: 'responsibility_transferred',
      oldValue: current,
      newValue: newUserId,
    });

    // Collaborators stay with the task when the responsible changes. The new
    // responsible stops being a collaborator, and a task left without a
    // responsible keeps no collaborators.
    if (newUserId === null) await clearCollaborators(t, groupTaskId, user.id);
    else await dropCollaborator(t, groupTaskId, newUserId, user.id);
  });
  return detail(user, groupTaskId);
}

// ---- Collaborators ----------------------------------------------------------

async function dropCollaborator(t, groupTaskId, userId, actorId) {
  if (await groupTaskRepo.removeCollaborator(t, groupTaskId, userId)) {
    await groupTaskRepo.addHistory(t, { groupTaskId, actorId, eventType: 'collaborator_removed', oldValue: userId });
  }
}

export async function clearCollaborators(t, groupTaskId, actorId) {
  const current = (await groupTaskRepo.collaboratorsFor(t, [groupTaskId])).get(groupTaskId);
  for (const person of current) await dropCollaborator(t, groupTaskId, person.id, actorId);
}

// Only the responsible student decides who collaborates on their task
// (teachers and administrators can correct it). A task without a responsible
// student cannot have collaborators.
async function lockForCollaborators(t, user, groupTaskId) {
  const { groupTask, access } = await lockForWrite(t, user, groupTaskId);
  if (!access.canManage && groupTask.responsible_user_id !== user.id) {
    throw forbidden('Només la persona responsable pot gestionar els col·laboradors de la tasca.');
  }
  if (groupTask.responsible_user_id === null) {
    throw conflict('Una tasca sense responsable no pot tenir col·laboradors.', 'task_unassigned');
  }
  return groupTask;
}

export async function addCollaborator(user, groupTaskId, body) {
  const userId = v.id(body.user_id, 'col·laborador');
  await db.tx(async (t) => {
    const groupTask = await lockForCollaborators(t, user, groupTaskId);
    if (userId === groupTask.responsible_user_id) throw badRequest('La persona responsable no pot ser també col·laboradora.');
    if (!(await groupRepo.isMember(t, groupTask.group_id, userId))) {
      throw badRequest('Els col·laboradors han de ser membres del grup.');
    }
    const current = (await groupTaskRepo.collaboratorsFor(t, [groupTaskId])).get(groupTaskId);
    if (current.some((person) => person.id === userId)) throw conflict('Aquesta persona ja col·labora en la tasca.');
    await groupTaskRepo.addCollaborator(t, { groupTaskId, groupId: groupTask.group_id, userId, addedBy: user.id });
    await groupTaskRepo.addHistory(t, { groupTaskId, actorId: user.id, eventType: 'collaborator_added', newValue: userId });
  });
  return detail(user, groupTaskId);
}

export async function removeCollaborator(user, groupTaskId, userId) {
  await db.tx(async (t) => {
    await lockForCollaborators(t, user, groupTaskId);
    if (!(await groupTaskRepo.removeCollaborator(t, groupTaskId, userId))) {
      throw notFound('Aquesta persona no col·labora en la tasca.');
    }
    await groupTaskRepo.addHistory(t, { groupTaskId, actorId: user.id, eventType: 'collaborator_removed', oldValue: userId });
  });
  return detail(user, groupTaskId);
}

export async function addComment(user, groupTaskId, body) {
  const content = v.text(body.content, 'comentari', { max: 5000 });
  await db.tx(async (t) => {
    await lockForWrite(t, user, groupTaskId);
    const commentId = await groupTaskRepo.addComment(t, { groupTaskId, authorId: user.id, content });
    await groupTaskRepo.addHistory(t, { groupTaskId, actorId: user.id, eventType: 'comment_added', newValue: commentId });
  });
  return detail(user, groupTaskId);
}

export async function history(user, groupTaskId) {
  await groupTaskAccessById(db, user, groupTaskId);
  return groupTaskRepo.history(db, groupTaskId);
}
