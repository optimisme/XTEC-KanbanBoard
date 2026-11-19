const COLUMNS = 'id, oidc_issuer, oidc_subject, email, name, password_hash, role, status, last_login_at, created_at, updated_at';

export async function findById(db, id) {
  const rows = await db.query(`SELECT ${COLUMNS} FROM users WHERE id = ?`, [id]);
  return rows[0] || null;
}

export async function findByIdentity(db, issuer, subject) {
  const rows = await db.query(
    `SELECT ${COLUMNS} FROM users WHERE oidc_issuer = ? AND oidc_subject = ?`,
    [issuer, subject]
  );
  return rows[0] || null;
}

export async function findByEmail(db, email) {
  const rows = await db.query(`SELECT ${COLUMNS} FROM users WHERE email = ?`, [email]);
  return rows[0] || null;
}

export async function findByIds(db, ids) {
  if (ids.length === 0) return [];
  return db.query(`SELECT ${COLUMNS} FROM users WHERE id IN (?)`, [ids]);
}

export async function create(db, { issuer, subject, email, name, role, status }) {
  const result = await db.query(
    'INSERT INTO users (oidc_issuer, oidc_subject, email, name, role, status) VALUES (?, ?, ?, ?, ?, ?)',
    [issuer, subject, email, name, role, status]
  );
  return result.insertId;
}

export async function bindIdentity(db, id, issuer, subject) {
  await db.query('UPDATE users SET oidc_issuer = ?, oidc_subject = ? WHERE id = ?', [issuer, subject, id]);
}

export async function setPasswordHash(db, id, passwordHash) {
  await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, id]);
}

// Ends a person's sessions, optionally keeping one (the one making the
// request). The session store keeps each session as JSON text.
export async function deleteSessions(db, userId, exceptSessionId = '') {
  await db.query(
    `DELETE FROM sessions
      WHERE session_id <> ? AND JSON_VALID(data) AND JSON_EXTRACT(data, '$.userId') = ?`,
    [exceptSessionId, userId]
  );
}

export async function touchLogin(db, id) {
  await db.query('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
}

export async function list(db, { status, role } = {}) {
  const where = [];
  const params = [];
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (role) {
    where.push('role = ?');
    params.push(role);
  }
  return db.query(
    `SELECT ${COLUMNS} FROM users ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY name ASC, id ASC`,
    params
  );
}

export async function update(db, id, fields) {
  const allowed = ['name', 'role', 'status'];
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
  await db.query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
}

// Active accounts of one role whose name or email contains the text typed so
// far. LIKE wildcards in the text are escaped, so it is matched literally.
export function suggest(db, { role, text, limit }) {
  const pattern = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return db.query(
    `SELECT id, name, email FROM users
      WHERE role = ? AND status = 'active' AND (email LIKE ? OR name LIKE ?)
      ORDER BY name ASC, id ASC LIMIT ?`,
    [role, pattern, pattern, limit]
  );
}
