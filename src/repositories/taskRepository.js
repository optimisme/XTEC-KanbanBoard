const COLUMNS = `td.id, td.project_id, td.title, td.description, td.sort_order,
  td.version, td.author_id, u.name AS author_name, td.deleted_at, td.created_at, td.updated_at`;

export async function findById(db, id) {
  const rows = await db.query(
    `SELECT ${COLUMNS} FROM task_definitions td JOIN users u ON u.id = td.author_id WHERE td.id = ?`,
    [id]
  );
  return rows[0] || null;
}

// Global project order: the single source of task priority.
export function listByProject(db, projectId) {
  return db.query(
    `SELECT ${COLUMNS} FROM task_definitions td JOIN users u ON u.id = td.author_id
      WHERE td.project_id = ? AND td.deleted_at IS NULL
      ORDER BY td.sort_order ASC, td.id ASC`,
    [projectId]
  );
}

export async function countActive(db, projectId) {
  const rows = await db.query(
    'SELECT COUNT(*) AS n FROM task_definitions WHERE project_id = ? AND deleted_at IS NULL',
    [projectId]
  );
  return rows[0].n;
}

export async function nextSortOrder(db, projectId) {
  const rows = await db.query(
    'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM task_definitions WHERE project_id = ? AND deleted_at IS NULL',
    [projectId]
  );
  return Number(rows[0].next);
}

export async function create(db, { projectId, title, description, sortOrder, authorId }) {
  const result = await db.query(
    `INSERT INTO task_definitions (project_id, title, description, sort_order, author_id)
     VALUES (?, ?, ?, ?, ?)`,
    [projectId, title, description, sortOrder, authorId]
  );
  return result.insertId;
}

export async function update(db, id, { title, description, version }) {
  await db.query(
    'UPDATE task_definitions SET title = ?, description = ?, version = ? WHERE id = ?',
    [title, description, version, id]
  );
}

export async function softDelete(db, id) {
  await db.query('UPDATE task_definitions SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
}

export async function setSortOrder(db, id, sortOrder) {
  await db.query('UPDATE task_definitions SET sort_order = ? WHERE id = ?', [sortOrder, id]);
}

export async function setModules(db, taskId, projectId, moduleIds) {
  await db.query('DELETE FROM task_modules WHERE task_id = ?', [taskId]);
  if (moduleIds.length === 0) return;
  await db.query('INSERT INTO task_modules (task_id, project_id, module_id) VALUES ?', [
    moduleIds.map((moduleId) => [taskId, projectId, moduleId]),
  ]);
}

export async function insertVersion(db, { taskId, version, title, description, modules, userId }) {
  await db.query(
    `INSERT INTO task_versions (task_id, version, title, description, modules, modified_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [taskId, version, title, description, JSON.stringify(modules), userId]
  );
}

export function versions(db, taskId) {
  return db.query(
    `SELECT tv.id, tv.task_id, tv.version, tv.title, tv.description, tv.modules,
            tv.modified_by, u.name AS modified_by_name, tv.created_at
       FROM task_versions tv JOIN users u ON u.id = tv.modified_by
      WHERE tv.task_id = ? ORDER BY tv.version DESC`,
    [taskId]
  );
}
