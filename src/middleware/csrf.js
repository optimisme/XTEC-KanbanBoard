import crypto from 'node:crypto';
import { HttpError } from '../utils/errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Synchronizer token pattern: the token lives in the server-side session and
// must be echoed in the X-CSRF-Token header of every state-changing request.
export function csrfToken(req) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  return req.session.csrfToken;
}

export function csrfProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const expected = req.session && req.session.csrfToken;
  const received = req.get('x-csrf-token') || '';
  const valid =
    Boolean(expected) &&
    received.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
  if (!valid) throw new HttpError(403, 'invalid_csrf_token', 'La sessió ha caducat. Torna a carregar la pàgina.');
  next();
}
