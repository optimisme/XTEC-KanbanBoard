import config from '../config/index.js';
import * as oidc from '../auth/oidc.js';
import { csrfToken } from '../middleware/csrf.js';
import * as authService from '../services/authService.js';
import { HttpError } from '../utils/errors.js';
import * as v from '../validators/index.js';

const COOKIE_NAME = 'kanban.sid';

function regenerate(req) {
  return new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
}

function save(req) {
  return new Promise((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
}

// A fresh session id after authentication prevents session fixation.
async function establishSession(req, user) {
  await regenerate(req);
  req.session.userId = user.id;
  csrfToken(req);
  await save(req);
}

// GET /api/session — who am I, plus the CSRF token for later requests.
export async function session(req, res) {
  res.json({
    user: req.user ? authService.publicUser(req.user) : null,
    csrf_token: csrfToken(req),
    app_name: config.appName,
    // Domains whose accounts are accepted, shown next to the email fields.
    email_domains: config.allowedEmailDomains,
    dev_auth: config.devAuthEnabled,
    oidc_configured: config.oidc.configured,
    oidc_provider: config.oidc.provider,
  });
}

// GET /auth/login — redirects to the institutional identity provider.
export async function login(req, res) {
  try {
    const { url, pending } = await oidc.beginLogin();
    req.session.oidc = pending;
    await save(req);
    res.redirect(url);
  } catch (err) {
    if (!(err instanceof HttpError) && !config.isTest) console.error('OIDC login failed:', err.message);
    res.redirect(`/#/login?error=${err instanceof HttpError ? err.code : 'login_failed'}`);
  }
}

// GET <callback path> — validates the provider response and opens the session.
export async function callback(req, res) {
  const pending = req.session.oidc;
  delete req.session.oidc;
  try {
    if (!pending) throw new HttpError(400, 'login_expired', 'La sessió d\'inici ha caducat.');
    const queryString = new URL(req.originalUrl, config.appUrl).search;
    const identity = await oidc.completeLogin(queryString, pending);
    const user = await authService.loginWithIdentity(identity);
    await establishSession(req, user);
    res.redirect('/');
  } catch (err) {
    if (!(err instanceof HttpError) && !config.isTest) console.error('OIDC callback failed:', err.message);
    res.redirect(`/#/login?error=${err instanceof HttpError ? err.code : 'login_failed'}`);
  }
}

// POST /auth/logout
export async function logout(req, res) {
  await new Promise((resolve) => req.session.destroy(() => resolve()));
  res.clearCookie(COOKIE_NAME);
  res.status(204).end();
}

// POST /auth/dev-login — development and tests only. The route is not even
// registered unless config.devAuthEnabled, which is always false in production.
export async function devLogin(req, res) {
  const email = v.text(req.body.email, 'correu', { max: 255 }).toLowerCase();
  const user = await authService.loginWithIdentity({
    issuer: 'dev-login',
    subject: email,
    email,
    emailVerified: true,
    name: v.text(req.body.name, 'nom', { max: 200, required: false }),
  });
  await establishSession(req, user);
  res.json({ user: authService.publicUser(user), csrf_token: csrfToken(req) });
}

// Failed password logins per client address: after MAX_FAILURES the
// address must wait until the window ends. Kept in memory on purpose; it only
// needs to slow down password guessing.
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const failures = new Map();

function failureEntry(key) {
  const entry = failures.get(key);
  if (entry && entry.resetAt > Date.now()) return entry;
  failures.delete(key);
  return null;
}

// POST /auth/password-login — the administrator from .env (username) or any
// account that has set a password (email).
export async function passwordLogin(req, res) {
  const key = req.ip;
  const entry = failureEntry(key);
  if (entry && entry.count >= MAX_FAILURES) {
    throw new HttpError(429, 'too_many_attempts', "Massa intents fallits. Torna-ho a provar d'aquí a uns minuts.");
  }

  const identifier = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const user = identifier && password ? await authService.loginWithPassword(identifier, password) : null;
  if (!user) {
    const current = entry || { count: 0, resetAt: Date.now() + FAILURE_WINDOW_MS };
    current.count += 1;
    failures.set(key, current);
    throw new HttpError(401, 'invalid_credentials', "L'usuari o la contrasenya no són correctes.");
  }

  failures.delete(key);
  await establishSession(req, user);
  res.json({ user: authService.publicUser(user), csrf_token: csrfToken(req) });
}

export { COOKIE_NAME };
