import { db } from '../db/pool.js';
import * as moduleRepo from '../repositories/moduleRepository.js';
import { readableTextColor } from '../utils/colors.js';
import { conflict, notFound } from '../utils/errors.js';
import * as v from '../validators/index.js';

function parse(body) {
  const name = v.text(body.name, 'nom', { max: 120 });
  const color = v.color(body.color);
  // The readable text color is derived from the background unless given.
  const textColor = body.text_color ? v.color(body.text_color, 'color del text') : readableTextColor(color);
  return { name, color, textColor };
}

function rethrowDuplicate(err) {
  if (err.code === 'ER_DUP_ENTRY') throw conflict('Ja existeix un mòdul amb aquest nom.');
  throw err;
}

export function list() {
  return moduleRepo.list(db);
}

export async function create(body) {
  const data = parse(body);
  const id = await moduleRepo.create(db, data).catch(rethrowDuplicate);
  return moduleRepo.findById(db, id);
}

export async function update(id, body) {
  const data = parse(body);
  if (!(await moduleRepo.findById(db, id))) throw notFound("No s'ha trobat el mòdul.");
  await moduleRepo.update(db, id, data).catch(rethrowDuplicate);
  return moduleRepo.findById(db, id);
}

export async function remove(id) {
  if (!(await moduleRepo.findById(db, id))) throw notFound("No s'ha trobat el mòdul.");
  try {
    await moduleRepo.remove(db, id);
  } catch (err) {
    if (err.code === 'ER_ROW_IS_REFERENCED_2') {
      throw conflict("No es pot eliminar el mòdul perquè s'utilitza en algun projecte.");
    }
    throw err;
  }
}
