import config from '../config/index.js';
import { db } from '../db/pool.js';
import * as userRepo from '../repositories/userRepository.js';
import { badRequest, conflict, notFound } from '../utils/errors.js';
import * as v from '../validators/index.js';

const ROLES = ['admin', 'teacher', 'student'];
const STATUSES = ['pending', 'active', 'rejected', 'disabled'];

function present(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    last_login_at: user.last_login_at,
    created_at: user.created_at,
    updated_at: user.updated_at,
  };
}

export function assertInstitutionalEmail(email) {
  const domain = email.slice(email.lastIndexOf('@') + 1);
  if (!config.allowedEmailDomains.includes(domain)) {
    throw badRequest(`El correu ha de ser d'un domini institucional (${config.allowedEmailDomains.join(', ')}).`);
  }
}

// Tells a teacher or administrator whether an email already has an account,
// before they add that person to a group.
export async function lookupStudent(body) {
  const email = v.email(body.email);
  assertInstitutionalEmail(email);
  const user = await userRepo.findByEmail(db, email);
  if (!user) return { email, found: false };
  let problem = null;
  if (user.role !== 'student') problem = "Aquest correu no és d'un compte d'alumnat.";
  else if (user.status === 'rejected' || user.status === 'disabled') problem = 'Aquest compte està desactivat. Contacta amb administració.';
  return { email, found: true, id: user.id, name: user.name, problem };
}

// Adds a person by email before they have ever signed in. The account is
// active from the start; on their first institutional login the verified
// email links it to their identity, so no approval step is needed.
export async function create(body) {
  const email = v.email(body.email);
  const name = v.text(body.name, 'nom', { max: 200 });
  const role = v.oneOf(body.role, 'rol', ROLES);
  assertInstitutionalEmail(email);
  try {
    const id = await userRepo.create(db, { issuer: null, subject: null, email, name, role, status: 'active' });
    return present(await userRepo.findById(db, id));
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw conflict('Ja existeix un usuari amb aquest correu.');
    throw err;
  }
}

export async function list(query) {
  const status = query.status ? v.oneOf(query.status, 'status', STATUSES) : undefined;
  const role = query.role ? v.oneOf(query.role, 'role', ROLES) : undefined;
  return (await userRepo.list(db, { status, role })).map(present);
}

// Role and status changes by an administrator (approve, reject, enable, disable).
export async function update(actor, userId, body) {
  const fields = {};
  if (body.role !== undefined) fields.role = v.oneOf(body.role, 'rol', ROLES);
  if (body.status !== undefined) fields.status = v.oneOf(body.status, 'estat', STATUSES);
  if (body.name !== undefined) fields.name = v.text(body.name, 'nom', { max: 200 });
  if (Object.keys(fields).length === 0) throw badRequest('No hi ha cap canvi a aplicar.');

  return db.tx(async (t) => {
    const user = await userRepo.findById(t, userId);
    if (!user) throw notFound("No s'ha trobat l'usuari.");
    if (user.id === actor.id && (fields.role || fields.status)) {
      // Prevents an administrator from locking themselves out.
      throw conflict('No pots canviar el teu propi rol ni estat.');
    }
    await userRepo.update(t, userId, fields);
    return present(await userRepo.findById(t, userId));
  });
}

export async function updateOwnProfile(actor, body) {
  const name = v.text(body.name, 'nom', { max: 200 });
  await userRepo.update(db, actor.id, { name });
  return present(await userRepo.findById(db, actor.id));
}
