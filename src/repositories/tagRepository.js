const COLUMNS = 'pt.id, pt.project_id, pt.name, pt.color, pt.text_color';

export function listForProject(db, projectId) {
  return db.query(`SELECT ${COLUMNS} FROM project_tags pt WHERE pt.project_id = ? ORDER BY pt.name ASC`, [projectId]);
}

export async function findById(db, id) {
  const rows = await db.query(`SELECT ${COLUMNS} FROM project_tags pt WHERE pt.id = ?`, [id]);
  return rows[0] || null;
}

export async function create(db, { projectId, name, color, textColor }) {
  const result = await db.query('INSERT INTO project_tags (project_id, name, color, text_color) VALUES (?, ?, ?, ?)', [
    projectId,
    name,
    color,
    textColor,
  ]);
  return result.insertId;
}

export async function update(db, id, { name, color, textColor }) {
  await db.query('UPDATE project_tags SET name = ?, color = ?, text_color = ? WHERE id = ?', [name, color, textColor, id]);
}

// Tasks that had the tag lose it (ON DELETE CASCADE on task_tags).
export async function remove(db, id) {
  await db.query('DELETE FROM project_tags WHERE id = ?', [id]);
}

export async function setTaskTags(db, taskId, projectId, tagIds) {
  await db.query('DELETE FROM task_tags WHERE task_id = ?', [taskId]);
  if (tagIds.length === 0) return;
  await db.query('INSERT INTO task_tags (task_id, project_id, tag_id) VALUES ?', [
    tagIds.map((tagId) => [taskId, projectId, tagId]),
  ]);
}

// Tags of several tasks at once: Map(taskId -> [tag]).
export async function mapForTasks(db, taskIds) {
  const map = new Map(taskIds.map((taskId) => [taskId, []]));
  if (taskIds.length === 0) return map;
  const rows = await db.query(
    `SELECT tt.task_id, pt.id, pt.name, pt.color, pt.text_color
       FROM task_tags tt JOIN project_tags pt ON pt.id = tt.tag_id
      WHERE tt.task_id IN (?) ORDER BY pt.name ASC`,
    [taskIds]
  );
  for (const { task_id: taskId, ...tag } of rows) map.get(taskId).push(tag);
  return map;
}

// The color a tag name already has in some other project, to keep the same
// label looking the same everywhere.
export async function colorUsedElsewhere(db, name) {
  const rows = await db.query('SELECT color, text_color FROM project_tags WHERE name = ? ORDER BY id ASC LIMIT 1', [name]);
  return rows[0] || null;
}

