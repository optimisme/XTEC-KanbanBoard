import { db } from '../db/pool.js';
import * as tagRepo from '../repositories/tagRepository.js';
import { readableTextColor } from '../utils/colors.js';
import { badRequest, conflict, notFound } from '../utils/errors.js';
import * as v from '../validators/index.js';
import { assertWritable, managerAccess, projectAccess } from './accessService.js';

// Tags are free labels that belong to one project. They classify and color
// tasks and never affect permissions.

const MAX_TAGS_PER_TASK = 12;
const PALETTE = ['#4f46e5', '#0d9488', '#fcd34d', '#db2777', '#0284c7', '#65a30d', '#ea580c', '#7c3aed', '#be123c', '#475569'];

const tagName = (value) => v.text(value, 'etiqueta', { max: 40 });

function rethrowDuplicate(err) {
  if (err.code === 'ER_DUP_ENTRY') throw conflict('Ja hi ha una etiqueta amb aquest nom en aquest projecte.');
  throw err;
}

// A color for a brand-new tag: the one the same name has in another project,
// or the first palette color the project is not using yet.
async function pickColor(t, name, existing) {
  const elsewhere = await tagRepo.colorUsedElsewhere(t, name);
  if (elsewhere) return { color: elsewhere.color, textColor: elsewhere.text_color };
  const used = new Set(existing.map((tag) => tag.color));
  const color = PALETTE.find((c) => !used.has(c)) || PALETTE[existing.length % PALETTE.length];
  return { color, textColor: readableTextColor(color) };
}

// Turns a list of tag names into project tags, creating the ones that do not
// exist yet. Must run inside the transaction that saves the task.
export async function resolveNames(t, projectId, names) {
  if (names === undefined || names === null) return [];
  if (!Array.isArray(names)) throw badRequest('Les etiquetes han de ser una llista.');
  const cleaned = [];
  for (const raw of names) {
    const name = tagName(raw);
    if (!cleaned.some((n) => n.toLowerCase() === name.toLowerCase())) cleaned.push(name);
  }
  if (cleaned.length > MAX_TAGS_PER_TASK) throw badRequest(`Una tasca pot tenir com a màxim ${MAX_TAGS_PER_TASK} etiquetes.`);

  const existing = await tagRepo.listForProject(t, projectId);
  const resolved = [];
  for (const name of cleaned) {
    let tag = existing.find((e) => e.name.toLowerCase() === name.toLowerCase());
    if (!tag) {
      const colors = await pickColor(t, name, existing);
      const id = await tagRepo.create(t, { projectId, name, ...colors });
      tag = { id, project_id: projectId, name, color: colors.color, text_color: colors.textColor };
      existing.push(tag);
    }
    resolved.push(tag);
  }
  return resolved;
}

export async function list(user, projectId) {
  await projectAccess(db, user, projectId);
  return tagRepo.listForProject(db, projectId);
}

// What to offer while tagging a task: this project's tags, plus names used in
// the person's other projects (created here when chosen).
export async function suggestions(user, projectId) {
  await managerAccess(db, user, projectId);
  const own = await tagRepo.listForProject(db, projectId);
  const others = await tagRepo.namesFromOtherProjects(db, { projectId, teacherId: user.role === 'admin' ? null : user.id });
  const ownNames = new Set(own.map((tag) => tag.name.toLowerCase()));
  return { project: own, other: others.filter((tag) => !ownNames.has(tag.name.toLowerCase())) };
}

export async function create(user, projectId, body) {
  const name = tagName(body.name);
  const { project } = await managerAccess(db, user, projectId);
  assertWritable(project);
  const id = await db
    .tx(async (t) => {
      const existing = await tagRepo.listForProject(t, projectId);
      const colors = body.color
        ? { color: v.color(body.color), textColor: readableTextColor(v.color(body.color)) }
        : await pickColor(t, name, existing);
      return tagRepo.create(t, { projectId, name, ...colors });
    })
    .catch(rethrowDuplicate);
  return tagRepo.findById(db, id);
}

async function loadManaged(user, tagId) {
  const tag = await tagRepo.findById(db, tagId);
  if (!tag) throw notFound("No s'ha trobat l'etiqueta.");
  const { project } = await managerAccess(db, user, tag.project_id);
  assertWritable(project);
  return tag;
}

export async function update(user, tagId, body) {
  const name = tagName(body.name);
  const color = v.color(body.color);
  await loadManaged(user, tagId);
  await tagRepo.update(db, tagId, { name, color, textColor: readableTextColor(color) }).catch(rethrowDuplicate);
  return tagRepo.findById(db, tagId);
}

export async function remove(user, tagId) {
  await loadManaged(user, tagId);
  await tagRepo.remove(db, tagId);
}
