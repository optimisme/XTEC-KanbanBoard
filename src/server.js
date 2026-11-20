import config from './config/index.js';
import { createApp } from './app.js';
import { closePool, pool } from './db/pool.js';
import { attachRealtime } from './realtime/hub.js';

async function start() {
  // Fail fast with a clear message when the database is unreachable or the
  // migrations have not been applied.
  try {
    await pool.query('SELECT 1 FROM users LIMIT 1');
  } catch (err) {
    console.error(`Database is not ready (${err.code || err.message}). Check the DB_* settings and run "npm run migrate".`);
    process.exit(1);
  }

  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`Educational Kanban listening on ${config.appUrl} (${config.nodeEnv})`);
    if (config.devAuthEnabled) console.warn('WARNING: development login is enabled. Never use this in production.');
  });

  const closeRealtime = attachRealtime(server, app);

  const shutdown = () => {
    closeRealtime();
    server.close(async () => {
      await app.locals.sessionStore.close().catch(() => {});
      await closePool().catch(() => {});
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start();
