import crypto from 'node:crypto';
import fs from 'node:fs';
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

// Frontend files are served under a path that contains a fingerprint of their
// contents (/static/<fingerprint>/...). Every deploy that changes a file gets
// new URLs, so browsers and CDNs can cache them forever and still pick up a
// new version at once. Only the small HTML page is never cached.
function fingerprint(dir) {
  const hash = crypto.createHash('sha256');
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    hash.update(path.relative(dir, file)).update(fs.readFileSync(file));
  }
  return hash.digest('hex').slice(0, 12);
}
const assetVersion = fingerprint(publicDir);
const assetBase = `/static/${assetVersion}`;
const escapeHtml = (text) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const indexHtml = fs
  .readFileSync(path.join(publicDir, 'index.html'), 'utf8')
  .replace(/<title>.*?<\/title>/, `<title>${escapeHtml(config.appName)}</title>`)
  .replace(/(href|src)="\/(css|js|assets)\//g, `$1="${assetBase}/$2/`);

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
          // The real-time channel (/ws). Older browsers do not let 'self'
          // cover WebSockets, so its address is listed as well.
          'connect-src': ["'self'", config.appUrl.replace(/^http/, 'ws')],
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

  const sessionParser = session({
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
  });
  // Also used by the real-time channel to recognise who opens a socket.
  app.locals.sessionParser = sessionParser;
  app.use(sessionParser);

  app.use(express.json({ limit: '1mb' }));
  // A request without a JSON object as its body is handled as an empty one,
  // so a missing field is reported as a validation error, not as a crash.
  app.use((req, res, next) => {
    if (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body)) req.body = {};
    next();
  });

  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  app.get(['/', '/index.html'], (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type('html').send(indexHtml);
  });
  // While developing, files change without a restart, so they are not cached.
  const assetCache = config.nodeEnv === 'development' ? {} : { immutable: true, maxAge: '365d' };
  app.use(assetBase, express.static(publicDir, { index: false, ...assetCache }));
  // Unversioned paths stay available (for example the icon used inside the app).
  app.use(express.static(publicDir, { index: false }));
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
