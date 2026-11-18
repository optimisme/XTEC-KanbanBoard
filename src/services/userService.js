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
