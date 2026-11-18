const COLUMNS = 'm.id, m.name, m.color, m.text_color, m.created_at, m.updated_at';

export function list(db) {
  return db.query(`SELECT ${COLUMNS} FROM modules m ORDER BY m.name ASC`);
}

export async function findById(db, id) {
  const rows = await db.query(`SELECT ${COLUMNS} FROM modules m WHERE m.id = ?`, [id]);
  return rows[0] || null;
}

export async function findByIds(db, ids) {
  if (ids.length === 0) return [];
  return db.query(`SELECT ${COLUMNS} FROM modules m WHERE m.id IN (?)`, [ids]);
}

export async function create(db, { name, color, textColor }) {
  const result = await db.query('INSERT INTO modules (name, color, text_color) VALUES (?, ?, ?)', [
    name,
    color,
    textColor,
  ]);
  return result.insertId;
}

export async function update(db, id, { name, color, textColor }) {
  await db.query('UPDATE modules SET name = ?, color = ?, text_color = ? WHERE id = ?', [
    name,
    color,
    textColor,
    id,
  ]);
}

export async function remove(db, id) {
  await db.query('DELETE FROM modules WHERE id = ?', [id]);
}

export function listForProject(db, projectId) {
  return db.query(
    `SELECT m.id, m.name, m.color, m.text_color
       FROM project_modules pm JOIN modules m ON m.id = pm.module_id
      WHERE pm.project_id = ? ORDER BY m.name ASC`,
    [projectId]
  );
}

export async function addToProject(db, projectId, moduleIds) {
  if (moduleIds.length === 0) return;
  await db.query('INSERT INTO project_modules (project_id, module_id) VALUES ?', [
    moduleIds.map((moduleId) => [projectId, moduleId]),
  ]);
}

export async function removeFromProject(db, projectId, moduleIds) {
  if (moduleIds.length === 0) return;
  await db.query('DELETE FROM project_modules WHERE project_id = ? AND module_id IN (?)', [projectId, moduleIds]);
}

// Modules of several tasks at once: Map(taskId -> [module]).
export async function mapForTasks(db, taskIds) {
  const map = new Map(taskIds.map((taskId) => [taskId, []]));
  if (taskIds.length === 0) return map;
  const rows = await db.query(
    `SELECT tm.task_id, m.id, m.name, m.color, m.text_color
       FROM task_modules tm JOIN modules m ON m.id = tm.module_id
      WHERE tm.task_id IN (?) ORDER BY m.name ASC`,
    [taskIds]
  );
  for (const { task_id: taskId, ...module } of rows) map.get(taskId).push(module);
  return map;
}
