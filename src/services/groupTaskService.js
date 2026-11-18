import { db } from '../db/pool.js';
import * as groupRepo from '../repositories/groupRepository.js';
import * as groupTaskRepo from '../repositories/groupTaskRepository.js';
import * as moduleRepo from '../repositories/moduleRepository.js';
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

function presentCard(row, modules, access, user) {
  return {
    id: row.id,
    group_id: row.group_id,
    task_id: row.task_id,
    title: row.title,
    sort_order: row.sort_order,
    modules,
    status: row.status,
    responsible: row.responsible_user_id ? { id: row.responsible_user_id, name: row.responsible_name } : null,
    assigned_at: row.assigned_at,
    completed_at: row.completed_at,
    completed_by: row.completed_by ? { id: row.completed_by, name: row.completed_by_name } : null,
    completed_version: row.completed_version,
    block_reason: row.block_reason,
    blocked_at: row.blocked_at,
    comment_count: row.comment_count,
    allowed_transitions: allowedTransitions(access, row.status),
    can_transfer:
      access.project.status !== 'archived' &&
      (access.canManage || (row.responsible_user_id !== null && row.responsible_user_id === user.id)),
  };
}

export async function board(user, groupId) {
  const access = await groupAccess(db, user, groupId);
  const [rows, members] = await Promise.all([groupTaskRepo.board(db, groupId), groupRepo.members(db, groupId)]);
  const modules = await moduleRepo.mapForTasks(db, rows.map((r) => r.task_id));
  return {
    project: { id: access.project.id, name: access.project.name, status: access.project.status },
    group: access.group,
    access: access.level,
    can_manage: access.canManage,
    members,
    tasks: rows.map((row) => presentCard(row, modules.get(row.task_id), access, user)),
  };
}

export async function detail(user, groupTaskId) {
  const access = await groupTaskAccessById(db, user, groupTaskId);
  const row = await groupTaskRepo.findDetailed(db, groupTaskId);
  if (row.deleted_at) throw notFound("No s'ha trobat la tasca.");

  const [definition, modules, members, comments, blockEvents, history] = await Promise.all([
    taskRepo.findById(db, row.task_id),
    moduleRepo.mapForTasks(db, [row.task_id]),
    groupRepo.members(db, row.group_id),
    groupTaskRepo.comments(db, groupTaskId),
    groupTaskRepo.blockEvents(db, groupTaskId),
    groupTaskRepo.history(db, groupTaskId),
  ]);

  return {
    ...presentCard(row, modules.get(row.task_id), access, user),
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
