// Project listing ("Els meus projectes") and the project create/edit form.
import { api } from '../api.js';
import { append, field, h, modal, run } from '../ui.js';

function defaultAcademicYear() {
  const now = new Date();
  const start = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  return `${start}-${start + 1}`;
}

// Modal form used both to create and to edit a project.
export async function openProjectForm({ project = null, onSaved }) {
  const name = h('input', { type: 'text', maxlength: '200', required: true, value: project ? project.name : '' });
  const year = h('input', {
    type: 'text', required: true, pattern: '\\d{4}-(\\d{2}|\\d{4})', placeholder: '2026-2027',
    value: project ? project.academic_year : defaultAcademicYear(),
  });
  const description = h('textarea', { rows: '4' });
  description.value = project ? project.description || '' : '';
  const save = h('button', { class: 'btn primary', type: 'submit' }, project ? 'Desa els canvis' : 'Crea el projecte');

  const form = h(
    'form',
    {
      onSubmit: (event) => {
        event.preventDefault();
        run(save, async () => {
          const body = {
            name: name.value,
            academic_year: year.value,
            description: description.value,
          };
          const saved = project
            ? await api.put(`/api/projects/${project.id}`, body)
            : await api.post('/api/projects', body);
          dialog.close();
          onSaved(saved);
        });
      },
    },
    field('Nom', name),
    field('Curs acadèmic', year, 'Format: 2026-2027'),
    field('Descripció (opcional, admet Markdown)', description),
    h('div', { class: 'card-actions' }, save)
  );
  const dialog = modal({ title: project ? 'Edita el projecte' : 'Nou projecte', body: form });
}

function projectCard(project, user) {
  const href = user.role === 'student' ? `#/groups/${project.my_group_id}` : `#/projects/${project.id}`;
  return h(
    'a',
    { class: 'card link-card', href },
    h('div', { class: 'card-title' },
      h('h2', {}, project.name),
      project.status === 'archived' ? h('span', { class: 'tag' }, 'Arxivat') : null),
    h('div', { class: 'meta' },
      h('span', {}, `Curs ${project.academic_year}`),
      user.role === 'student'
        ? h('span', {}, `Grup ${project.my_group_number}`)
        : h('span', {}, `${project.group_count} ${project.group_count === 1 ? 'grup' : 'grups'}`),
      h('span', {}, `${project.task_count} ${project.task_count === 1 ? 'tasca' : 'tasques'}`))
  );
}

export async function renderProjects(view, params, { user }) {
  const projects = await api.get('/api/projects');
  const active = projects.filter((p) => p.status === 'active');
  const archived = projects.filter((p) => p.status === 'archived');

  append(view, 
    h('div', { class: 'page-header' },
      h('div', { class: 'titles' },
        h('h1', {}, user.role === 'student' ? 'Els meus projectes' : 'Projectes'),
        user.role === 'teacher' ? h('p', { class: 'muted' }, 'Projectes que has creat o on tens docència assignada.') : null),
      user.role !== 'student'
        ? h('div', { class: 'actions' },
            h('button', {
              class: 'btn primary', type: 'button',
              onClick: () => openProjectForm({ onSaved: (p) => { window.location.hash = `#/projects/${p.id}/settings`; } }),
            }, 'Nou projecte'))
        : null)
  );

  if (projects.length === 0) {
    const text = {
      admin: 'Encara no hi ha cap projecte. Crea\'n el primer.',
      teacher: "Encara no tens cap projecte. Crea'n un o demana a administració que t'assigni a un d'existent.",
      student: 'Encara no formes part de cap grup de projecte.',
    }[user.role];
    append(view, h('div', { class: 'empty' }, text));
    return;
  }

  append(view, h('div', { class: 'grid' }, active.map((p) => projectCard(p, user))));
  if (archived.length > 0) {
    append(view, 
      h('h2', { style: { margin: '28px 0 12px' } }, 'Projectes arxivats'),
      h('div', { class: 'grid' }, archived.map((p) => projectCard(p, user)))
    );
  }
}
