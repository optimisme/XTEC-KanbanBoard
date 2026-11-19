import { db } from '../db/pool.js';
import * as projectRepo from '../repositories/projectRepository.js';
import * as tagRepo from '../repositories/tagRepository.js';
import * as taskRepo from '../repositories/taskRepository.js';
import { conflict, HttpError, notFound } from '../utils/errors.js';
import * as v from '../validators/index.js';
import { assertWritable, managerAccess } from './accessService.js';
import { resolveNames } from './tagService.js';
import { insertTask, list as listTasks } from './taskService.js';

const MAX_MARKDOWN_LENGTH = 500000;
// "**Tags:** a, b" (also "Etiquetes", and "Modules"/"Mòduls" from older files).
const TAG_WORDS = '(?:tags|etiquetes|modules|mòduls|moduls)';
const TAGS_LINE = new RegExp(`^\\*\\*${TAG_WORDS}\\s*:\\*\\*\\s*(.*)$|^\\*\\*${TAG_WORDS}\\*\\*\\s*:\\s*(.*)$`, 'i');
const DESCRIPTION_HEADING = /^###\s+(?:description|descripció|descripcio)\s*$/i;

// Parses the import format: every "## " heading starts a task, in document
// order. Lines inside fenced code blocks are never treated as structure.
export function parseTasksMarkdown(markdown) {
  const tasks = [];
  let current = null;
  let inFence = false;

  for (const line of String(markdown).replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;

    if (!inFence && /^##\s+/.test(line)) {
      current = { title: line.replace(/^##\s+/, '').trim(), tagNames: null, description: [] };
      tasks.push(current);
      continue;
    }
    if (!current) continue; // Preamble such as the "# Project Tasks" title.

    if (!inFence) {
      const tags = line.trim().match(TAGS_LINE);
      if (tags && current.tagNames === null) {
        current.tagNames = (tags[1] ?? tags[2]).split(',').map((name) => name.trim()).filter(Boolean);
        continue;
      }
      // The optional "### Description" heading is only a marker.
      if (DESCRIPTION_HEADING.test(line.trim())) continue;
    }
    current.description.push(line);
  }

  const clean = (lines) =>
    lines
      .join('\n')
      .replace(/\n\s*---\s*$/, '') // Trailing separator between tasks.
      .trim();

  return tasks.map((task) => ({
    title: task.title,
    tagNames: task.tagNames || [],
    description: clean(task.description),
  }));
}

// Validates parsed tasks and builds the preview. Tags are optional; names the
// project does not have yet will be created by the import.
function buildPreview(parsed, projectTags) {
  const byName = new Map(projectTags.map((tag) => [tag.name.toLowerCase(), tag]));
  const errors = [];
  const warnings = [];
  const seenTitles = new Set();
  const newTags = new Map();

  if (parsed.length === 0) {
    errors.push('El document no conté cap tasca. Cada tasca ha de començar amb un títol de nivell 2 (##).');
  }

  const tasks = parsed.map((task, index) => {
    const position = index + 1;
    const label = `Tasca ${position}${task.title ? ` («${task.title}»)` : ''}`;

    if (!task.title) errors.push(`${label}: el títol és buit.`);
    if (task.title.length > 200) errors.push(`${label}: el títol supera els 200 caràcters.`);
    if (task.tagNames.length > 12) errors.push(`${label}: té més de 12 etiquetes.`);
    for (const name of task.tagNames) {
      if (name.length > 40) errors.push(`${label}: l'etiqueta «${name.slice(0, 40)}…» supera els 40 caràcters.`);
      else if (!byName.has(name.toLowerCase())) newTags.set(name.toLowerCase(), name);
    }
    if (task.description.length > 100000) errors.push(`${label}: la descripció és massa llarga.`);
    if (!task.description) warnings.push(`${label}: no té descripció.`);
    if (seenTitles.has(task.title.toLowerCase())) warnings.push(`${label}: el títol està repetit.`);
    seenTitles.add(task.title.toLowerCase());

    return {
      order: position,
      title: task.title,
      description: task.description,
      tags: task.tagNames.map((name) => {
        const existing = byName.get(name.toLowerCase());
        return existing ? { ...existing, is_new: false } : { name, is_new: true };
      }),
    };
  });

  return { tasks, errors, warnings, new_tags: [...newTags.values()], valid: errors.length === 0 };
}

function readMarkdown(body) {
  return v.text(body.markdown, 'markdown', { max: MAX_MARKDOWN_LENGTH });
}

// The import is only possible while the project has no task definitions.
async function loadImportableProject(executor, projectId, { lock }) {
  const project = lock ? await projectRepo.lock(executor, projectId) : await projectRepo.findById(executor, projectId);
  if (!project) throw notFound("No s'ha trobat el projecte.");
  assertWritable(project);
  if ((await taskRepo.countActive(executor, projectId)) > 0) {
    throw conflict('La importació només és possible quan el projecte encara no té cap tasca.', 'import_not_available');
  }
  return project;
}

export async function preview(user, projectId, body) {
  await managerAccess(db, user, projectId);
  const markdown = readMarkdown(body);
  await loadImportableProject(db, projectId, { lock: false });
  return buildPreview(parseTasksMarkdown(markdown), await tagRepo.listForProject(db, projectId));
}

// Atomic: either every task (with its tags and group instances) is created, or none.
export async function importTasks(user, projectId, body) {
  await managerAccess(db, user, projectId);
  const markdown = readMarkdown(body);

  await db.tx(async (t) => {
    await loadImportableProject(t, projectId, { lock: true });
    const result = buildPreview(parseTasksMarkdown(markdown), await tagRepo.listForProject(t, projectId));
    if (!result.valid) {
      throw new HttpError(422, 'import_invalid', "El document conté errors i no s'ha importat cap tasca.", {
        errors: result.errors,
        warnings: result.warnings,
      });
    }
    for (const task of result.tasks) {
      await insertTask(t, {
        projectId,
        userId: user.id,
        data: { title: task.title, description: task.description },
        tags: await resolveNames(t, projectId, task.tags.map((tag) => tag.name)),
        sortOrder: task.order,
      });
    }
  });
  return listTasks(user, projectId);
}

// A ready-to-edit example: one line of instructions (text before the first
// task is never imported) and tasks with one tag, two tags and no tags, using
// the project's own tag names where it has some.
export async function template(user, projectId) {
  await managerAccess(db, user, projectId);
  const names = (await tagRepo.listForProject(db, projectId)).map((tag) => tag.name);
  const first = names[0] || 'Programació';
  const second = names[1] || 'Bases de dades';

  return `# Tasques del projecte

Cada títol de nivell 2 és una tasca. La línia **Tags:** és opcional: etiquetes separades per comes.

---

## Crear el repositori de GitHub

**Tags:** ${first}

Creeu el repositori de GitHub del grup.

- El repositori existeix.
- Tots els membres del grup hi tenen accés.

---

## Dissenyar la base de dades

**Tags:** ${second}, ${first}

Creeu l'esquema relacional de la base de dades.

---

## Presentar el projecte

Una tasca sense etiquetes.
`;
}
