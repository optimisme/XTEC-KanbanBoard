import { db } from '../db/pool.js';
import * as userRepo from '../repositories/userRepository.js';
import { forbidden, HttpError, unauthenticated } from '../utils/errors.js';

// Loads the session user from the database on every request, so that role or
// status changes (for example disabling an account) apply immediately.
export async function loadUser(req, res, next) {
  req.user = null;
  if (req.session && req.session.userId) {
    req.user = await userRepo.findById(db, req.session.userId);
  }
  next();
}

// Pending, rejected and disabled accounts cannot reach application data.
export function requireActive(req, res, next) {
  if (!req.user) throw unauthenticated();
  if (req.user.status !== 'active') {
    throw new HttpError(403, `account_${req.user.status}`, 'El teu compte no està actiu.');
  }
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) throw forbidden();
    next();
  };
}
