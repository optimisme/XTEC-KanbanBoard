import crypto from 'node:crypto';
import config from '../config/index.js';
import { db } from '../db/pool.js';
import * as userRepo from '../repositories/userRepository.js';
import { HttpError } from '../utils/errors.js';
import { fakeVerify, verifyPassword } from '../utils/passwords.js';

// Registers or recognises a user from an identity that has already been
// verified by the identity provider. Never call this with data that comes
// straight from the browser.
export async function loginWithIdentity({ issuer, subject, email, emailVerified, name }) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!issuer || !subject || !cleanEmail || !emailVerified) {
    throw new HttpError(403, 'email_not_verified', "El proveïdor d'identitat no ha verificat el correu.");
  }
  const domain = cleanEmail.slice(cleanEmail.lastIndexOf('@') + 1);
  if (!config.allowedEmailDomains.includes(domain)) {
    throw new HttpError(403, 'domain_not_allowed', 'Només es permeten comptes del domini institucional.');
  }
  const isInitialAdmin = Boolean(config.initialAdminEmail) && cleanEmail === config.initialAdminEmail;

  return db.tx(async (t) => {
    let user = await userRepo.findByIdentity(t, issuer, subject);
    if (!user) {
      const byEmail = await userRepo.findByEmail(t, cleanEmail);
      if (byEmail && byEmail.oidc_subject) {
        // The email is already bound to a different identity.
        throw new HttpError(409, 'identity_conflict', 'Aquest correu ja està associat a una altra identitat.');
      }
      if (byEmail) {
        // Account created in advance (create-admin script): bind it now.
        await userRepo.bindIdentity(t, byEmail.id, issuer, subject);
        user = byEmail;
      } else {
        const id = await userRepo.create(t, {
          issuer,
          subject,
          email: cleanEmail,
          name: String(name || '').trim().slice(0, 200) || cleanEmail.split('@')[0],
          role: isInitialAdmin ? 'admin' : 'student',
          status: isInitialAdmin ? 'active' : 'pending',
        });
        user = { id };
      }
    }
    if (isInitialAdmin) {
      const current = await userRepo.findById(t, user.id);
      if (current.status === 'pending') await userRepo.update(t, user.id, { role: 'admin', status: 'active' });
    }
    await userRepo.touchLogin(t, user.id);
    return userRepo.findById(t, user.id);
  });
}

const LOCAL_ADMIN_ISSUER = 'local-admin';

// Compares in constant time, independently of the lengths involved.
function safeEqual(a, b) {
  const digest = (value) => crypto.createHash('sha256').update(String(value)).digest();
  return crypto.timingSafeEqual(digest(a), digest(b));
}

// Password login for the single administrator configured in .env
// (ADMIN_USERNAME / ADMIN_PASSWORD). Returns null when the credentials are wrong.
export async function loginLocalAdmin(username, password) {
  const { adminLogin } = config;
  if (!adminLogin.enabled) return null;
  const valid = safeEqual(username, adminLogin.username) & safeEqual(password, adminLogin.password);
  if (!valid) return null;

  return db.tx(async (t) => {
    let user = await userRepo.findByIdentity(t, LOCAL_ADMIN_ISSUER, adminLogin.username);
    if (!user) {
      const id = await userRepo.create(t, {
        issuer: LOCAL_ADMIN_ISSUER,
        subject: adminLogin.username,
        email: `${adminLogin.username.toLowerCase()}@local.invalid`,
        name: 'Administrador',
        role: 'admin',
        status: 'active',
      });
      user = { id };
    }
    // The .env credentials are the root of trust: this account is always an
    // active administrator, even if it was changed from the user screen.
    await userRepo.update(t, user.id, { role: 'admin', status: 'active' });
    await userRepo.touchLogin(t, user.id);
    return userRepo.findById(t, user.id);
  });
}

// Password sign-in. The identifier is the administrator username from .env
// or the email of an account that has set a password. Returns null when the
// credentials are wrong, without revealing which part was.
export async function loginWithPassword(identifier, password) {
  const admin = await loginLocalAdmin(identifier, password);
  if (admin) return admin;

  const user = identifier.includes('@') ? await userRepo.findByEmail(db, identifier.toLowerCase()) : null;
  if (!user || !user.password_hash) {
    await fakeVerify(password);
    return null;
  }
  if (!(await verifyPassword(password, user.password_hash))) return null;
  await userRepo.touchLogin(db, user.id);
  return userRepo.findById(db, user.id);
}

// The administrator from .env signs in with the password kept there.
export const isLocalAdmin = (user) => user.oidc_issuer === LOCAL_ADMIN_ISSUER;

// What the browser may know about the signed-in person (never the hash).
export function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    has_password: Boolean(user.password_hash),
    can_set_password: !isLocalAdmin(user),
  };
}
