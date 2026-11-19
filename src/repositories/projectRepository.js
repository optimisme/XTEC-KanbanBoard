const COLUMNS = 'p.id, p.name, p.description, p.academic_year, p.status, p.created_at, p.updated_at';

export async function findById(db, id) {
  const rows = await db.query(`SELECT ${COLUMNS} FROM projects p WHERE p.id = ?`, [id]);
  return rows[0] || null;
}

// Locks the project row. Used to serialize structural changes (new groups,
// new tasks, imports, reordering) inside a transaction.
export async function lock(db, id) {
  const rows = await db.query(`SELECT ${COLUMNS} FROM projects p WHERE p.id = ? FOR UPDATE`, [id]);
  return rows[0] || null;
}

export function listAll(db) {
  return db.query(`SELECT ${COLUMNS} FROM projects p ORDER BY p.status ASC, p.academic_year DESC, p.name ASC`);
}

export function listForTeacher(db, userId) {
  return db.query(
    `SELECT ${COLUMNS} FROM projects p
       JOIN project_teachers pt ON pt.project_id = p.id AND pt.user_id = ?
      ORDER BY p.status ASC, p.academic_year DESC, p.name ASC`,
    [userId]
  );
}

export function listForStudent(db, userId) {
  return db.query(
    `SELECT ${COLUMNS}, g.id AS my_group_id, g.group_number AS my_group_number, g.name AS my_group_name
       FROM projects p
       JOIN group_students gs ON gs.project_id = p.id AND gs.user_id = ?
       JOIN project_groups g ON g.id = gs.group_id
      ORDER BY p.status ASC, p.academic_year DESC, p.name ASC`,
    [userId]
  );
}

export async function create(db, { name, description, academicYear }) {
  const result = await db.query('INSERT INTO projects (name, description, academic_year) VALUES (?, ?, ?)', [
    name,
    description || null,
    academicYear,
  ]);
  return result.insertId;
}

export async function update(db, id, { name, description, academicYear }) {
  await db.query('UPDATE projects SET name = ?, description = ?, academic_year = ? WHERE id = ?', [
    name,
    description || null,
    academicYear,
    id,
  ]);
}

// Permanently removes a project and everything that belongs to it, children
// first so that every foreign key is satisfied. User accounts are not touched.
export async function removeCompletely(db, id) {
  const byGroupTask = (table) =>
    `DELETE x FROM ${table} x JOIN group_tasks gt ON gt.id = x.group_task_id WHERE gt.project_id = ?`;
  await db.query(byGroupTask('task_collaborators'), [id]);
  await db.query(byGroupTask('task_history'), [id]);
  await db.query(byGroupTask('task_block_events'), [id]);
  await db.query(byGroupTask('task_comments'), [id]);
  await db.query('DELETE FROM group_tasks WHERE project_id = ?', [id]);
  await db.query('DELETE FROM group_students WHERE project_id = ?', [id]);
  await db.query('DELETE FROM project_groups WHERE project_id = ?', [id]);
  await db.query('DELETE FROM task_tags WHERE project_id = ?', [id]);
  await db.query('DELETE v FROM task_versions v JOIN task_definitions td ON td.id = v.task_id WHERE td.project_id = ?', [id]);
  await db.query('DELETE FROM task_definitions WHERE project_id = ?', [id]);
  await db.query('DELETE FROM project_tags WHERE project_id = ?', [id]);
  await db.query('DELETE FROM project_teachers WHERE project_id = ?', [id]);
  await db.query('DELETE FROM projects WHERE id = ?', [id]);
}

export async function setStatus(db, id, status) {
  await db.query('UPDATE projects SET status = ? WHERE id = ?', [status, id]);
}

export function teachers(db, projectId) {
  return db.query(
    `SELECT u.id, u.name, u.email
       FROM project_teachers pt JOIN users u ON u.id = pt.user_id
      WHERE pt.project_id = ? ORDER BY u.name ASC`,
    [projectId]
  );
}

export async function isTeacher(db, projectId, userId) {
  const rows = await db.query('SELECT 1 FROM project_teachers WHERE project_id = ? AND user_id = ?', [
    projectId,
    userId,
  ]);
  return rows.length > 0;
}

export async function addTeacher(db, projectId, userId) {
  await db.query('INSERT IGNORE INTO project_teachers (project_id, user_id) VALUES (?, ?)', [projectId, userId]);
}

export async function removeTeacher(db, projectId, userId) {
  await db.query('DELETE FROM project_teachers WHERE project_id = ? AND user_id = ?', [projectId, userId]);
}

export async function setTeachers(db, projectId, userIds) {
  await db.query('DELETE FROM project_teachers WHERE project_id = ?', [projectId]);
  if (userIds.length === 0) return;
  await db.query('INSERT INTO project_teachers (project_id, user_id) VALUES ?', [
    userIds.map((userId) => [projectId, userId]),
  ]);
}

// Map(projectId -> { groups, tasks }) for project listings.
export async function counts(db, projectIds) {
  const map = new Map(projectIds.map((projectId) => [projectId, { groups: 0, tasks: 0 }]));
  if (projectIds.length === 0) return map;
  const groups = await db.query(
    'SELECT project_id, COUNT(*) AS n FROM project_groups WHERE project_id IN (?) GROUP BY project_id',
    [projectIds]
  );
  const tasks = await db.query(
    `SELECT project_id, COUNT(*) AS n FROM task_definitions
      WHERE project_id IN (?) AND deleted_at IS NULL GROUP BY project_id`,
    [projectIds]
  );
  for (const row of groups) map.get(row.project_id).groups = row.n;
  for (const row of tasks) map.get(row.project_id).tasks = row.n;
  return map;
}
