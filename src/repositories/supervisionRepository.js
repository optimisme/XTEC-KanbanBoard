import { HISTORY_SELECT } from './groupTaskRepository.js';

// Every group task of a project (non-deleted definitions only).
export function matrixCells(db, projectId) {
  return db.query(
    `SELECT gt.id, gt.group_id, gt.task_id, gt.status, gt.responsible_user_id, u.name AS responsible_name
       FROM group_tasks gt
       JOIN task_definitions td ON td.id = gt.task_id
       LEFT JOIN users u ON u.id = gt.responsible_user_id
      WHERE gt.project_id = ? AND td.deleted_at IS NULL`,
    [projectId]
  );
}

// Currently blocked tasks of active projects. teacherId limits the result to
// the projects a teacher is assigned to; null means every project (admins).
export function blockedTasks(db, teacherId) {
  return db.query(
    `SELECT gt.id AS group_task_id, p.id AS project_id, p.name AS project_name,
            g.id AS group_id, g.group_number, td.title, td.sort_order,
            gt.responsible_user_id, ru.name AS responsible_name,
            be.reason, be.blocked_at, bu.name AS blocked_by_name
       FROM group_tasks gt
       JOIN task_definitions td ON td.id = gt.task_id AND td.deleted_at IS NULL
       JOIN projects p ON p.id = gt.project_id AND p.status = 'active'
       JOIN project_groups g ON g.id = gt.group_id
       JOIN task_block_events be ON be.group_task_id = gt.id AND be.unblocked_at IS NULL
       JOIN users bu ON bu.id = be.blocked_by
       LEFT JOIN users ru ON ru.id = gt.responsible_user_id
      WHERE gt.status = 'blocked'
        AND (? IS NULL OR EXISTS (SELECT 1 FROM project_teachers pt
                                   WHERE pt.project_id = p.id AND pt.user_id = ?))
      ORDER BY be.blocked_at ASC`,
    [teacherId, teacherId]
  );
}

const TASK_REF = `gt.id AS group_task_id, gt.group_id, g.group_number, td.title, td.sort_order, gt.status`;
const TASK_JOIN = `
  JOIN group_tasks gt ON gt.id = x.group_task_id AND gt.project_id = ?
  JOIN task_definitions td ON td.id = gt.task_id
  JOIN project_groups g ON g.id = gt.group_id`;

export function assignedTasks(db, projectId, userId) {
  return db.query(
    `SELECT ${TASK_REF}, gt.assigned_at, gt.completed_at, cu.name AS completed_by_name
       FROM group_tasks gt
       JOIN task_definitions td ON td.id = gt.task_id AND td.deleted_at IS NULL
       JOIN project_groups g ON g.id = gt.group_id
       LEFT JOIN users cu ON cu.id = gt.completed_by
      WHERE gt.project_id = ? AND gt.responsible_user_id = ?
      ORDER BY td.sort_order ASC, td.id ASC`,
    [projectId, userId]
  );
}

// Tasks whose current completion was performed by the student.
export function completedTasks(db, projectId, userId) {
  return db.query(
    `SELECT ${TASK_REF}, gt.completed_at, gt.responsible_user_id, ru.name AS responsible_name
       FROM group_tasks gt
       JOIN task_definitions td ON td.id = gt.task_id AND td.deleted_at IS NULL
       JOIN project_groups g ON g.id = gt.group_id
       LEFT JOIN users ru ON ru.id = gt.responsible_user_id
      WHERE gt.project_id = ? AND gt.status = 'completed' AND gt.completed_by = ?
      ORDER BY gt.completed_at DESC`,
    [projectId, userId]
  );
}

// Blocking events the student opened, or that affect tasks they are responsible for.
export function blockEvents(db, projectId, userId) {
  return db.query(
    `SELECT ${TASK_REF}, x.reason, x.blocked_at, x.unblocked_at, x.duration_seconds,
            bu.name AS blocked_by_name, uu.name AS unblocked_by_name
       FROM task_block_events x ${TASK_JOIN}
       JOIN users bu ON bu.id = x.blocked_by
       LEFT JOIN users uu ON uu.id = x.unblocked_by
      WHERE x.blocked_by = ? OR (x.unblocked_at IS NULL AND gt.responsible_user_id = ?)
      ORDER BY x.blocked_at DESC`,
    [projectId, userId, userId]
  );
}

export function comments(db, projectId, userId) {
  return db.query(
    `SELECT ${TASK_REF}, x.id, x.content, x.created_at
       FROM task_comments x ${TASK_JOIN}
      WHERE x.author_id = ? AND x.type = 'comment'
      ORDER BY x.created_at DESC`,
    [projectId, userId]
  );
}

export function attachments(db, projectId, userId) {
  return db.query(
    `SELECT ${TASK_REF}, x.id, x.kind, x.title, x.url, x.created_at
       FROM task_attachments x ${TASK_JOIN}
      WHERE x.author_id = ?
      ORDER BY x.created_at DESC`,
    [projectId, userId]
  );
}

// Responsibility events the student performed, received or lost.
export function transfers(db, projectId, userId) {
  return db.query(
    `SELECT hx.*, gt.group_id, g.group_number, td.title
       FROM (${HISTORY_SELECT}
              WHERE h.event_type IN ('auto_assigned', 'responsibility_transferred')
                AND (h.actor_id = ? OR h.old_value = ? OR h.new_value = ?)) hx
       JOIN group_tasks gt ON gt.id = hx.group_task_id AND gt.project_id = ?
       JOIN task_definitions td ON td.id = gt.task_id
       JOIN project_groups g ON g.id = gt.group_id
      ORDER BY hx.id DESC`,
    [userId, String(userId), String(userId), projectId]
  );
}

export function recentActivity(db, projectId, userId, limit) {
  return db.query(
    `SELECT hx.*, gt.group_id, g.group_number, td.title
       FROM (${HISTORY_SELECT} WHERE h.actor_id = ?) hx
       JOIN group_tasks gt ON gt.id = hx.group_task_id AND gt.project_id = ?
       JOIN task_definitions td ON td.id = gt.task_id
       JOIN project_groups g ON g.id = gt.group_id
      ORDER BY hx.id DESC LIMIT ?`,
    [userId, projectId, limit]
  );
}
