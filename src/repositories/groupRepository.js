const COLUMNS = 'g.id, g.project_id, g.group_number, g.github_url, g.created_at, g.updated_at';

export async function findById(db, id) {
  const rows = await db.query(`SELECT ${COLUMNS} FROM project_groups g WHERE g.id = ?`, [id]);
  return rows[0] || null;
}

export function listByProject(db, projectId) {
  return db.query(`SELECT ${COLUMNS} FROM project_groups g WHERE g.project_id = ? ORDER BY g.group_number ASC`, [
    projectId,
  ]);
}

export async function nextNumber(db, projectId) {
  const rows = await db.query(
    'SELECT COALESCE(MAX(group_number) + 1, 0) AS next FROM project_groups WHERE project_id = ?',
    [projectId]
  );
  return Number(rows[0].next);
}

export async function create(db, projectId, groupNumber) {
  const result = await db.query('INSERT INTO project_groups (project_id, group_number) VALUES (?, ?)', [
    projectId,
    groupNumber,
  ]);
  return result.insertId;
}

export async function remove(db, groupId) {
  await db.query('DELETE FROM group_students WHERE group_id = ?', [groupId]);
  await db.query('DELETE FROM project_groups WHERE id = ?', [groupId]);
}

export async function setGithubUrl(db, groupId, url) {
  await db.query('UPDATE project_groups SET github_url = ? WHERE id = ?', [url, groupId]);
}

export function members(db, groupId) {
  return db.query(
    `SELECT u.id, u.name, u.email
       FROM group_students gs JOIN users u ON u.id = gs.user_id
      WHERE gs.group_id = ? ORDER BY u.name ASC`,
    [groupId]
  );
}

// Map(groupId -> [student]) for every group of a project.
export async function membersByProject(db, projectId) {
  const rows = await db.query(
    `SELECT gs.group_id, u.id, u.name, u.email
       FROM group_students gs JOIN users u ON u.id = gs.user_id
      WHERE gs.project_id = ? ORDER BY u.name ASC`,
    [projectId]
  );
  const map = new Map();
  for (const { group_id: groupId, ...student } of rows) {
    if (!map.has(groupId)) map.set(groupId, []);
    map.get(groupId).push(student);
  }
  return map;
}

export async function isMember(db, groupId, userId) {
  const rows = await db.query('SELECT 1 FROM group_students WHERE group_id = ? AND user_id = ?', [groupId, userId]);
  return rows.length > 0;
}

// The group a student belongs to inside a project, if any.
export async function findStudentGroup(db, projectId, userId) {
  const rows = await db.query(
    `SELECT ${COLUMNS} FROM group_students gs JOIN project_groups g ON g.id = gs.group_id
      WHERE gs.project_id = ? AND gs.user_id = ?`,
    [projectId, userId]
  );
  return rows[0] || null;
}

export async function addStudents(db, groupId, projectId, userIds) {
  if (userIds.length === 0) return;
  await db.query('INSERT INTO group_students (group_id, project_id, user_id) VALUES ?', [
    userIds.map((userId) => [groupId, projectId, userId]),
  ]);
}

export async function removeStudents(db, groupId, userIds) {
  if (userIds.length === 0) return;
  await db.query('DELETE FROM group_students WHERE group_id = ? AND user_id IN (?)', [groupId, userIds]);
}

// Map(groupId -> { pending, in_progress, blocked, completed }).
export async function progressByProject(db, projectId) {
  const rows = await db.query(
    `SELECT gt.group_id, gt.status, COUNT(*) AS n
       FROM group_tasks gt JOIN task_definitions td ON td.id = gt.task_id
      WHERE gt.project_id = ? AND td.deleted_at IS NULL
      GROUP BY gt.group_id, gt.status`,
    [projectId]
  );
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.group_id)) map.set(row.group_id, { pending: 0, in_progress: 0, blocked: 0, completed: 0 });
    map.get(row.group_id)[row.status] = row.n;
  }
  return map;
}

// True when anything has ever happened on the group's board.
export async function hasActivity(db, groupId) {
  const rows = await db.query(
    `SELECT EXISTS (SELECT 1 FROM group_tasks WHERE group_id = ? AND (status <> 'pending' OR responsible_user_id IS NOT NULL))
         OR EXISTS (SELECT 1 FROM task_history h JOIN group_tasks gt ON gt.id = h.group_task_id WHERE gt.group_id = ?)
         OR EXISTS (SELECT 1 FROM task_comments c JOIN group_tasks gt ON gt.id = c.group_task_id WHERE gt.group_id = ?)
         AS active`,
    [groupId, groupId, groupId]
  );
  return Boolean(rows[0].active);
}
