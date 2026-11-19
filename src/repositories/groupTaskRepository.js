const COLUMNS = `gt.id, gt.group_id, gt.task_id, gt.project_id, gt.status, gt.responsible_user_id,
  gt.assigned_at, gt.completed_at, gt.completed_by, gt.completed_version, gt.created_at, gt.updated_at`;

export async function findById(db, id) {
  const rows = await db.query(`SELECT ${COLUMNS} FROM group_tasks gt WHERE gt.id = ?`, [id]);
  return rows[0] || null;
}

// Row lock: every state or responsibility change goes through this, so
// concurrent updates of one task are applied one after the other.
export async function lock(db, id) {
  const rows = await db.query(`SELECT ${COLUMNS} FROM group_tasks gt WHERE gt.id = ? FOR UPDATE`, [id]);
  return rows[0] || null;
}

export async function createForTask(db, taskId, projectId) {
  await db.query(
    `INSERT INTO group_tasks (group_id, task_id, project_id)
     SELECT g.id, ?, g.project_id FROM project_groups g WHERE g.project_id = ?`,
    [taskId, projectId]
  );
}

export async function createForGroup(db, groupId, projectId) {
  await db.query(
    `INSERT INTO group_tasks (group_id, task_id, project_id)
     SELECT ?, td.id, td.project_id FROM task_definitions td WHERE td.project_id = ?`,
    [groupId, projectId]
  );
}

export async function removeForGroup(db, groupId) {
  await db.query('DELETE FROM task_collaborators WHERE group_id = ?', [groupId]);
  await db.query('DELETE FROM group_tasks WHERE group_id = ?', [groupId]);
}

export async function update(db, id, fields) {
  const allowed = ['status', 'responsible_user_id', 'assigned_at', 'completed_at', 'completed_by', 'completed_version'];
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      params.push(fields[key]);
    }
  }
  if (sets.length === 0) return;
  params.push(id);
  await db.query(`UPDATE group_tasks SET ${sets.join(', ')} WHERE id = ?`, params);
}

const DETAIL_SELECT = `
  SELECT ${COLUMNS}, td.title, td.sort_order, td.version AS definition_version, td.deleted_at,
         ru.name AS responsible_name, cu.name AS completed_by_name,
         be.reason AS block_reason, be.blocked_at,
         (SELECT COUNT(*) FROM task_comments c WHERE c.group_task_id = gt.id AND c.type = 'comment') AS comment_count
    FROM group_tasks gt
    JOIN task_definitions td ON td.id = gt.task_id
    LEFT JOIN users ru ON ru.id = gt.responsible_user_id
    LEFT JOIN users cu ON cu.id = gt.completed_by
    LEFT JOIN task_block_events be ON be.group_task_id = gt.id AND be.unblocked_at IS NULL`;

// Board rows in the global project order.
export function board(db, groupId) {
  return db.query(
    `${DETAIL_SELECT} WHERE gt.group_id = ? AND td.deleted_at IS NULL ORDER BY td.sort_order ASC, td.id ASC`,
    [groupId]
  );
}

export async function findDetailed(db, id) {
  const rows = await db.query(`${DETAIL_SELECT} WHERE gt.id = ?`, [id]);
  return rows[0] || null;
}

export function listAssignedTo(db, groupId, userId) {
  return db.query('SELECT id FROM group_tasks WHERE group_id = ? AND responsible_user_id = ? FOR UPDATE', [
    groupId,
    userId,
  ]);
}

// ---- Collaborators --------------------------------------------------------

// Collaborators of several group tasks at once: Map(groupTaskId -> [{ id, name }]).
export async function collaboratorsFor(db, groupTaskIds) {
  const map = new Map(groupTaskIds.map((id) => [id, []]));
  if (groupTaskIds.length === 0) return map;
  const rows = await db.query(
    `SELECT tc.group_task_id, u.id, u.name
       FROM task_collaborators tc JOIN users u ON u.id = tc.user_id
      WHERE tc.group_task_id IN (?) ORDER BY u.name ASC`,
    [groupTaskIds]
  );
  for (const { group_task_id: groupTaskId, ...person } of rows) map.get(groupTaskId).push(person);
  return map;
}

export async function addCollaborator(db, { groupTaskId, groupId, userId, addedBy }) {
  await db.query('INSERT INTO task_collaborators (group_task_id, group_id, user_id, added_by) VALUES (?, ?, ?, ?)', [
    groupTaskId,
    groupId,
    userId,
    addedBy,
  ]);
}

export async function removeCollaborator(db, groupTaskId, userId) {
  const result = await db.query('DELETE FROM task_collaborators WHERE group_task_id = ? AND user_id = ?', [
    groupTaskId,
    userId,
  ]);
  return result.affectedRows > 0;
}

// The tasks of a group on which a student collaborates.
export function collaborationsOf(db, groupId, userId) {
  return db.query('SELECT group_task_id FROM task_collaborators WHERE group_id = ? AND user_id = ?', [groupId, userId]);
}

// ---- Comments -------------------------------------------------------------

export async function addComment(db, { groupTaskId, authorId, content, type = 'comment' }) {
  const result = await db.query(
    'INSERT INTO task_comments (group_task_id, author_id, content, type) VALUES (?, ?, ?, ?)',
    [groupTaskId, authorId, content, type]
  );
  return result.insertId;
}

export function comments(db, groupTaskId) {
  return db.query(
    `SELECT c.id, c.group_task_id, c.author_id, u.name AS author_name, u.role AS author_role,
            c.content, c.type, c.created_at
       FROM task_comments c JOIN users u ON u.id = c.author_id
      WHERE c.group_task_id = ? ORDER BY c.created_at ASC, c.id ASC`,
    [groupTaskId]
  );
}

// ---- Blocking events ------------------------------------------------------

export async function openBlock(db, { groupTaskId, reason, userId }) {
  await db.query('INSERT INTO task_block_events (group_task_id, reason, blocked_by) VALUES (?, ?, ?)', [
    groupTaskId,
    reason,
    userId,
  ]);
}

export async function closeBlock(db, { groupTaskId, userId }) {
  await db.query(
    `UPDATE task_block_events
        SET unblocked_by = ?, unblocked_at = CURRENT_TIMESTAMP,
            duration_seconds = TIMESTAMPDIFF(SECOND, blocked_at, CURRENT_TIMESTAMP)
      WHERE group_task_id = ? AND unblocked_at IS NULL`,
    [userId, groupTaskId]
  );
}

export function blockEvents(db, groupTaskId) {
  return db.query(
    `SELECT be.id, be.group_task_id, be.reason, be.blocked_by, bu.name AS blocked_by_name, be.blocked_at,
            be.unblocked_by, uu.name AS unblocked_by_name, be.unblocked_at, be.duration_seconds
       FROM task_block_events be
       JOIN users bu ON bu.id = be.blocked_by
       LEFT JOIN users uu ON uu.id = be.unblocked_by
      WHERE be.group_task_id = ? ORDER BY be.blocked_at DESC, be.id DESC`,
    [groupTaskId]
  );
}

// ---- Activity history (append-only) ---------------------------------------

export async function addHistory(db, { groupTaskId, actorId, eventType, oldValue = null, newValue = null }) {
  await db.query(
    'INSERT INTO task_history (group_task_id, actor_id, event_type, old_value, new_value) VALUES (?, ?, ?, ?, ?)',
    [groupTaskId, actorId, eventType, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue)]
  );
}

// For responsibility and collaborator events old_value / new_value hold user ids; their names
// are resolved here so clients do not need a user directory.
export const HISTORY_SELECT = `
  SELECT h.id, h.group_task_id, h.actor_id, au.name AS actor_name, au.role AS actor_role,
         h.event_type, h.old_value, h.new_value, ou.name AS old_user_name, nu.name AS new_user_name, h.created_at
    FROM task_history h
    JOIN users au ON au.id = h.actor_id
    LEFT JOIN users ou ON h.event_type IN ('auto_assigned', 'responsibility_transferred', 'collaborator_added', 'collaborator_removed')
                      AND ou.id = CAST(h.old_value AS UNSIGNED)
    LEFT JOIN users nu ON h.event_type IN ('auto_assigned', 'responsibility_transferred', 'collaborator_added', 'collaborator_removed')
                      AND nu.id = CAST(h.new_value AS UNSIGNED)`;

export function history(db, groupTaskId) {
  return db.query(`${HISTORY_SELECT} WHERE h.group_task_id = ? ORDER BY h.id ASC`, [groupTaskId]);
}
