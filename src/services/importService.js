import { db } from '../db/pool.js';
import * as projectRepo from '../repositories/projectRepository.js';
import * as moduleRepo from '../repositories/moduleRepository.js';
import * as taskRepo from '../repositories/taskRepository.js';
import { conflict, HttpError, notFound } from '../utils/errors.js';
import * as v from '../validators/index.js';
import { assertWritable, managerAccess } from './accessService.js';
import { insertTask, list as listTasks } from './taskService.js';

const MAX_MARKDOWN_LENGTH = 500000;
const MODULES_LINE = /^\*\*(?:modules|mòduls|moduls)\s*:\*\*\s*(.*)$|^\*\*(?:modules|mòduls|moduls)\*\*\s*:\s*(.*)$/i;
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
      current = { title: line.replace(/^##\s+/, '').trim(), moduleNames: null, description: [] };
      tasks.push(current);
      continue;
    }
    if (!current) continue; // Preamble such as the "# Project Tasks" title.

    if (!inFence) {
      const modules = line.trim().match(MODULES_LINE);
      if (modules && current.moduleNames === null) {
        current.moduleNames = (modules[1] ?? modules[2]).split(',').map((name) => name.trim()).filter(Boolean);
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
    moduleNames: task.moduleNames || [],
    description: clean(task.description),
  }));
}

// Validates parsed tasks against the project's modules and builds the preview.
function buildPreview(parsed, projectModules) {
  const byName = new Map(projectModules.map((m) => [m.name.toLowerCase(), m]));
  const errors = [];
  const warnings = [];
  const seenTitles = new Set();

  if (parsed.length === 0) {
    errors.push('El document no conté cap tasca. Cada tasca ha de començar amb un títol de nivell 2 (##).');
  }

  const tasks = parsed.map((task, index) => {
    const position = index + 1;
    const label = `Tasca ${position}${task.title ? ` («${task.title}»)` : ''}`;
    const modules = [];

    if (!task.title) errors.push(`${label}: el títol és buit.`);
    if (task.title.length > 200) errors.push(`${label}: el títol supera els 200 caràcters.`);
    if (task.moduleNames.length === 0) errors.push(`${label}: cal indicar almenys un mòdul (**Modules:** ...).`);
    for (const name of task.moduleNames) {
      const module = byName.get(name.toLowerCase());
      if (!module) errors.push(`${label}: el mòdul «${name}» no està associat al projecte.`);
      else if (!modules.includes(module)) modules.push(module);
    }
    if (task.description.length > 100000) errors.push(`${label}: la descripció és massa llarga.`);
    if (!task.description) warnings.push(`${label}: no té descripció.`);
    if (seenTitles.has(task.title.toLowerCase())) warnings.push(`${label}: el títol està repetit.`);
    seenTitles.add(task.title.toLowerCase());

    return {
      order: position,
      title: task.title,
      description: task.description,
      module_names: task.moduleNames,
      modules,
    };
  });

  return { tasks, errors, warnings, valid: errors.length === 0 };
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
  return buildPreview(parseTasksMarkdown(markdown), await moduleRepo.listForProject(db, projectId));
}

// Atomic: either every task (and its group instances) is created, or none.
export async function importTasks(user, projectId, body) {
  await managerAccess(db, user, projectId);
  const markdown = readMarkdown(body);

  await db.tx(async (t) => {
    await loadImportableProject(t, projectId, { lock: true });
    const result = buildPreview(parseTasksMarkdown(markdown), await moduleRepo.listForProject(t, projectId));
    if (!result.valid) {
      throw new HttpError(422, 'import_invalid', 'El document conté errors i no s\'ha importat cap tasca.', {
        errors: result.errors,
        warnings: result.warnings,
      });
    }
    for (const task of result.tasks) {
      await insertTask(t, {
        projectId,
        userId: user.id,
        data: { title: task.title, description: task.description },
        modules: task.modules,
        sortOrder: task.order,
      });
    }
  });
  return listTasks(user, projectId);
}

// A ready-to-edit example that uses the project's own module names.
export async function template(user, projectId) {
  await managerAccess(db, user, projectId);
  const project = await projectRepo.findById(db, projectId);
  if (!project) throw notFound("No s'ha trobat el projecte.");
  const names = (await moduleRepo.listForProject(db, projectId)).map((m) => m.name);
  const first = names[0] || 'Programació';
  const both = names.length > 1 ? `${names[0]}, ${names[1]}` : first;

  return `# Tasques del projecte

## Crear el repositori de GitHub

**Modules:** ${first}

### Description

Creeu el repositori de GitHub del grup.

- El repositori existeix.
- Tots els membres del grup hi tenen accés.

---

## Dissenyar la base de dades

**Modules:** ${both}

### Description

Creeu l'esquema relacional de la base de dades.

![Diagrama de la base de dades](https://example.com/diagram.png)

- Diagrama entitat-relació complet.
- Claus primàries i foranes definides.
`;
}
