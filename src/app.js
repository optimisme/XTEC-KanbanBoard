import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import mysqlSession from 'express-mysql-session';
import helmet from 'helmet';
import config from './config/index.js';
import { COOKIE_NAME } from './controllers/authController.js';
import { pool } from './db/pool.js';
import { loadUser } from './middleware/auth.js';
import { csrfProtection } from './middleware/csrf.js';
import { apiNotFound, errorHandler } from './middleware/errors.js';
import apiRoutes from './routes/api.js';
import authRoutes from './routes/auth.js';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const MySQLStore = mysqlSession(session);

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Behind the institute's reverse proxy the original protocol and client
  // address arrive in X-Forwarded-* headers.
  if (config.isProduction) app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'"],
          // Task descriptions may embed external images over https.
          'img-src': ["'self'", 'https:', 'data:'],
          'object-src': ["'none'"],
          'frame-ancestors': ["'none'"],
          'form-action': ["'self'"],
          'upgrade-insecure-requests': config.isProduction ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
    })
  );

  // Sessions live in MySQL (the "sessions" table created by the migrations).
  const sessionStore = new MySQLStore(
    { createDatabaseTable: false, clearExpired: true, checkExpirationInterval: 15 * 60 * 1000 },
    pool
  );
  app.locals.sessionStore = sessionStore;

  app.use(
    session({
      name: COOKIE_NAME,
      secret: config.sessionSecret,
      store: sessionStore,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.isProduction,
        maxAge: 8 * 60 * 60 * 1000,
      },
    })
  );

  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  app.use(express.static(publicDir, { index: 'index.html' }));
  app.use(authRoutes);
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', loadUser, csrfProtection, apiRoutes);
  app.use('/api', apiNotFound);
  app.use(errorHandler);

  return app;
}
