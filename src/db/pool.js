import mysql from 'mysql2/promise';
import config from '../config/index.js';

export const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.name,
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
  timezone: 'Z',
});

// All timestamps are stored and read as UTC.
pool.on('connection', (connection) => {
  connection.query("SET time_zone = '+00:00'");
});

function wrap(executor) {
  return {
    async query(sql, params) {
      const [rows] = await executor.query(sql, params);
      return rows;
    },
  };
}

const MAX_DEADLOCK_RETRIES = 3;

export const db = {
  ...wrap(pool),

  // Runs fn inside a transaction. fn receives an executor with the same
  // query() interface, so repositories work with or without a transaction.
  async tx(fn) {
    for (let attempt = 1; ; attempt += 1) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const result = await fn(wrap(connection));
        await connection.commit();
        return result;
      } catch (err) {
        await connection.rollback().catch(() => {});
        if (err.code === 'ER_LOCK_DEADLOCK' && attempt < MAX_DEADLOCK_RETRIES) continue;
        throw err;
      } finally {
        connection.release();
      }
    }
  },
};

export async function closePool() {
  await pool.end();
}
