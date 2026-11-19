// Project listing ("Els meus projectes") and the project create/edit form.
import { api } from '../api.js';
import { append, field, groupLabel, h, modal, run, toggleSwitch } from '../ui.js';

const YEARS_AHEAD = 5;

// The academic year that is running today: it starts in September, so until
// August it is still the one that began the previous calendar year.
function currentStartYear() {
  const now = new Date();
  return now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
}

// Dropdown of academic years, from the current one onwards. Choosing the
// first year fixes the second: every option is "year-(year + 1)". `selected`
// is an existing value such as "2025-2026"; it is kept in the list even when
// it is older than the current year. Without it, the current year is chosen.
export function academicYearSelect(selected = null) {
  const first = currentStartYear();
  const starts = Array.from({ length: YEARS_AHEAD + 1 }, (_, i) => first + i);
  const selectedStart = selected ? Number(String(selected).slice(0, 4)) : first;
  if (!starts.includes(selectedStart)) starts.push(selectedStart);
  starts.sort((a, b) => a - b);

  const select = h('select', { required: true },
    starts.map((start) => h('option', { value: `${start}-${start + 1}` }, `${start}-${start + 1}`)));
  select.value = `${selectedStart}-${selectedStart + 1}`;
  return select;
}

// Modal form used both to create and to edit a project.
export async function openProjectForm({ project = null, onSaved }) {
  const name = h('input', { type: 'text', maxlength: '200', required: true, value: project ? project.name : '' });
  const year = academicYearSelect(project ? project.academic_year : null);
  const description = h('textarea', { rows: '4' });
  description.value = project ? project.description || '' : '';
  let rankingVisible = project ? project.ranking_visible : false;
  const ranking = toggleSwitch("Mostra la classificació a l'alumnat", rankingVisible, (on) => { rankingVisible = on; });
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
            ranking_visible: rankingVisible,
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
    field('Curs acadèmic', year),
    field('Descripció (opcional, admet Markdown)', description),
    h('div', { class: 'field' }, ranking,
      h('div', { class: 'hint' }, "L'alumnat veu el progrés de tots els grups i la mitjana de la classe, sense els noms de les persones dels altres grups. El professorat la veu sempre.")),
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
        ? h('span', {}, groupLabel(project.my_group_number, project.my_group_name))
        : h('span', {}, `${project.group_count} ${project.group_count === 1 ? 'grup' : 'grups'}`),
      h('span', {}, `${project.task_count} ${project.task_count === 1 ? 'tasca' : 'tasques'}`))
  );
}

// Whether archived projects are shown. Kept for the browser session, so the
// choice survives moving between screens; they are hidden to start with.
const ARCHIVED_KEY = 'kanban.showArchived';
function showArchivedPreference() {
  try { return sessionStorage.getItem(ARCHIVED_KEY) === '1'; } catch { return false; }
}
function rememberShowArchived(value) {
  try { sessionStorage.setItem(ARCHIVED_KEY, value ? '1' : '0'); } catch { /* storage unavailable: not remembered */ }
}

export async function renderProjects(view, params, { user }) {
  const projects = await api.get('/api/projects');
  const active = projects.filter((p) => p.status === 'active');
  const archived = projects.filter((p) => p.status === 'archived');
  let showArchived = showArchivedPreference();

  const archivedSection = h('div', {});
  function drawArchived() {
    archivedSection.replaceChildren();
    if (!showArchived) return;
    append(archivedSection,
      h('h2', { style: { margin: '28px 0 12px' } }, 'Projectes arxivats'),
      archived.length > 0
        ? h('div', { class: 'grid' }, archived.map((p) => projectCard(p, user)))
        : h('p', { class: 'muted' }, 'No hi ha cap projecte arxivat.'));
  }
  const toggle = toggleSwitch(`Mostra els arxivats (${archived.length})`, showArchived, (on) => {
    showArchived = on;
    rememberShowArchived(on);
    drawArchived();
  });

  append(view,
    h('div', { class: 'page-header' },
      h('div', { class: 'titles' },
        h('h1', {}, user.role === 'student' ? 'Els meus projectes' : 'Projectes'),
        user.role === 'teacher' ? h('p', { class: 'muted' }, 'Projectes que has creat o on tens docència assignada.') : null),
      h('div', { class: 'actions' },
        toggle,
        // Projects are created by teachers; administrators only oversee them.
        user.role === 'teacher'
          ? h('button', {
              class: 'btn primary', type: 'button',
              onClick: () => openProjectForm({ onSaved: (p) => { window.location.hash = `#/projects/${p.id}/settings`; } }),
            }, 'Nou projecte')
          : null))
  );

  if (active.length === 0 && archived.length === 0) {
    const text = {
      admin: 'Encara no hi ha cap projecte. Els crea el professorat.',
      teacher: "Encara no tens cap projecte. Crea'n un o demana a administració que t'assigni a un d'existent.",
      student: 'Encara no formes part de cap grup de projecte.',
    }[user.role];
    append(view, h('div', { class: 'empty' }, text));
    return;
  }

  append(view,
    active.length > 0
      ? h('div', { class: 'grid' }, active.map((p) => projectCard(p, user)))
      : h('div', { class: 'empty' }, 'No hi ha cap projecte actiu.'),
    archivedSection);
  drawArchived();
}
