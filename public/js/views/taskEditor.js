// Shared task definitions: editor, read-only view, version history and the
// initial Markdown import.
import { api } from '../api.js';
import { append, clear, field, formatDateTime, h, modal, run, showError, tagChip, tagChips, tagPicker, toast } from '../ui.js';

// Create (taskId omitted) or edit a shared task definition.
export async function openTaskEditor({ projectId, taskId = null, onSaved }) {
  const [suggestions, task] = await Promise.all([
    api.get(`/api/projects/${projectId}/tags/suggestions`),
    taskId ? api.get(`/api/tasks/${taskId}`) : null,
  ]);

  const title = h('input', { type: 'text', maxlength: '200', required: true, value: task ? task.title : '' });
  const description = h('textarea', { class: 'code', rows: '14' });
  description.value = task ? task.description : '';
  const tags = tagPicker(task ? task.tags : [], suggestions);
  const save = h('button', { class: 'btn primary', type: 'submit' }, task ? 'Desa els canvis' : 'Crea la tasca');

  const form = h(
    'form',
    {
      onSubmit: (event) => {
        event.preventDefault();
        run(save, async () => {
          const body = {
            title: title.value,
            description: description.value,
            tags: tags.values(),
          };
          const saved = task ? await api.put(`/api/tasks/${task.id}`, body) : await api.post(`/api/projects/${projectId}/tasks`, body);
          dialog.close();
          toast(task ? 'Definició actualitzada per a tots els grups.' : 'Tasca creada a tots els grups.');
          onSaved(saved);
        });
      },
    },
    task
      ? h('div', { class: 'notice' }, "Els canvis es veuran a tots els grups. L'estat, les persones responsables, els comentaris i l'historial no es modifiquen.")
      : h('div', { class: 'notice' }, 'La tasca s\'afegirà al final de la llista i apareixerà com a pendent a tots els grups.'),
    field('Títol', title),
    field('Descripció', description, 'Admet Markdown: títols, llistes, enllaços, imatges i blocs de codi.'),
    h('div', { class: 'field' }, h('label', {}, 'Etiquetes (opcional)'), tags.el,
      h('div', { class: 'hint' }, "Tria'n de suggerides o escriu-ne una de nova; es crea en desar la tasca.")),
    h('div', { class: 'card-actions' },
      save,
      // The version history used to hang off the read-only view; keep it one click away.
      task ? h('button', { class: 'btn', type: 'button', onClick: () => openVersions(task.id).catch(showError) }, 'Historial de versions') : null)
  );
  const dialog = modal({ title: task ? 'Edita la tasca compartida' : 'Nova tasca compartida', body: form, wide: true });
}

export async function openVersions(taskId) {
  const versions = await api.get(`/api/tasks/${taskId}/versions`);
  const body = h('div', {}, versions.map((v) =>
    h('details', { class: 'box', open: v.current },
      h('summary', {},
        h('strong', {}, `Versió ${v.version}`),
        v.current ? h('span', { class: 'tag', style: { 'margin-left': '8px' } }, 'Actual') : null,
        h('span', { class: 'muted' }, ` · ${v.modified_by_name} · ${formatDateTime(v.created_at)}`)),
      h('h3', { style: { margin: '12px 0 6px' } }, v.title),
      h('div', { class: 'chips', style: { 'margin-bottom': '10px' } }, v.tags.map((tag) => h('span', { class: 'tag' }, tag.name))),
      h('div', { class: 'section-title' }, 'Descripció'),
      v.description_html ? h('div', { class: 'markdown', html: v.description_html }) : h('p', { class: 'muted' }, 'Sense descripció.'))));
  modal({ title: 'Historial de versions', body, wide: true });
}

// Read-only view of a shared definition, with management actions for staff.
export async function openDefinition(taskId, { canManage, writable, onChanged }) {
  const task = await api.get(`/api/tasks/${taskId}`);
  const body = h('div', {},
    h('div', { class: 'detail-meta' },
      tagChips(task.tags),
      h('span', { class: 'muted' }, `Versió ${task.version} · ${task.author.name} · ${formatDateTime(task.updated_at)}`)),
    h('h3', { class: 'section-title' }, 'Descripció'),
    task.description_html ? h('div', { class: 'box markdown', html: task.description_html }) : h('p', { class: 'muted' }, 'Sense descripció.'));

  const footer = canManage
    ? [
        h('button', { class: 'btn', type: 'button', onClick: () => openVersions(task.id) }, 'Historial de versions'),
        writable
          ? h('button', {
              class: 'btn primary', type: 'button',
              onClick: () => { dialog.close(); openTaskEditor({ projectId: task.project_id, taskId: task.id, onSaved: onChanged }); },
            }, 'Edita')
          : null,
      ]
    : null;
  const dialog = modal({ title: task.title, body, footer, wide: true });
}

// Initial Markdown import: paste or load a file, preview, then import.
export function openImport({ project, onDone }) {
  const text = h('textarea', { class: 'code', rows: '14', required: true, placeholder: '## Crear el repositori\n\n**Tags:** Programació, Bases de dades\n\nDescripció de la tasca, en Markdown.\n\n---\n\n## Presentar el projecte\n\nUna tasca sense etiquetes.' });
  const file = h('input', { type: 'file', accept: '.md,.markdown,.txt,text/markdown,text/plain', 'aria-label': 'Fitxer Markdown' });
  file.addEventListener('change', async () => {
    if (file.files[0]) text.value = await file.files[0].text();
  });
  const previewBox = h('div', {});
  const previewButton = h('button', { class: 'btn', type: 'button' }, 'Previsualitza');
  const importButton = h('button', { class: 'btn primary', type: 'button', disabled: true }, 'Importa les tasques');

  // Any edit invalidates the last preview.
  text.addEventListener('input', () => {
    importButton.disabled = true;
    clear(previewBox);
  });

  const messages = (title, items, type) =>
    items.length ? h('div', { class: `notice ${type}`, role: type === 'error' ? 'alert' : null }, h('strong', {}, title), h('ul', {}, items.map((i) => h('li', {}, i)))) : null;

  previewButton.addEventListener('click', () => run(previewButton, async () => {
    const preview = await api.post(`/api/projects/${project.id}/import/preview`, { markdown: text.value });
    importButton.disabled = !preview.valid;
    append(clear(previewBox), 
      messages('Errors (cal corregir-los abans d\'importar)', preview.errors, 'error'),
      messages('Avisos', preview.warnings, 'warn'),
      preview.tasks.length
        ? h('div', { class: 'table-wrap' },
            h('table', {},
              h('thead', {}, h('tr', {}, h('th', {}, 'Ordre'), h('th', {}, 'Tasca'), h('th', {}, 'Etiquetes'))),
              h('tbody', {}, preview.tasks.map((t) =>
                h('tr', {},
                  h('td', { class: 'num' }, String(t.order)),
                  h('td', {}, t.title || h('em', {}, '(sense títol)')),
                  h('td', {}, t.tags.length
                    ? h('div', { class: 'chips' }, t.tags.map((tag) => (tag.is_new ? h('span', { class: 'tag' }, `${tag.name} (nova)`) : tagChip(tag))))
                    : h('span', { class: 'muted' }, '—')))))))
        : null
    );
  }));

  importButton.addEventListener('click', () => run(importButton, async () => {
    const tasks = await api.post(`/api/projects/${project.id}/import`, { markdown: text.value });
    dialog.close();
    toast(`S'han importat ${tasks.length} tasques a tots els grups.`);
    onDone();
  }));

  const body = h('div', {},
    h('div', { class: 'notice' },
      'La importació només és possible mentre el projecte no té cap tasca. Cada títol de nivell 2 (##) és una tasca i l\'ordre del document serà l\'ordre global. ',
      h('a', { href: `/api/projects/${project.id}/import/template`, download: 'plantilla-tasques.md' }, 'Baixa la plantilla d\'exemple')),
    h('div', { class: 'field' }, h('label', {}, 'Carrega un fitxer Markdown'), file),
    field('…o enganxa aquí el contingut', text),
    previewBox);
  const dialog = modal({ title: 'Importa tasques des de Markdown', body, footer: [previewButton, importButton], wide: true });
}
