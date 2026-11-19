// Teacher supervision: blocked tasks dashboard and individual student
// contribution view.
import { api } from '../api.js';
import { append, clear, formatDateTime, formatDuration, h, secondsSince, showError, statusBadge } from '../ui.js';
import { historyItem, openTaskModal } from './taskModal.js';

export async function renderBlocked(view) {
  const holder = h('div', {});
  let tasks = [];

  async function load() {
    tasks = await api.get('/api/blocked-tasks');
    draw();
  }

  function draw() {
    if (tasks.length === 0) {
      append(clear(holder), h('div', { class: 'empty' }, 'No hi ha cap tasca bloquejada als teus projectes.'));
      return;
    }
    append(clear(holder), h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {},
        h('th', {}, 'Projecte'), h('th', {}, 'Grup'), h('th', {}, 'Tasca'), h('th', {}, 'Responsable'),
        h('th', {}, 'Motiu del bloqueig'), h('th', {}, 'Temps bloquejada'), h('th', {}, 'Bloquejada el'), h('th', {}, ''))),
      h('tbody', {}, tasks.map((t) => h('tr', {},
        h('td', {}, h('a', { href: `#/projects/${t.project_id}` }, t.project_name)),
        h('td', {}, h('a', { href: `#/groups/${t.group_id}` }, `Grup ${t.group_number}`)),
        h('td', {}, t.title),
        h('td', {}, t.responsible_name || h('span', { class: 'muted' }, 'Sense responsable')),
        h('td', { style: { 'max-width': '320px', 'overflow-wrap': 'anywhere' } }, t.reason),
        h('td', { class: 'num' }, formatDuration(secondsSince(t.blocked_at))),
        h('td', { class: 'muted' }, formatDateTime(t.blocked_at)),
        h('td', { class: 'actions' },
          h('button', {
            class: 'btn small', type: 'button',
            onClick: () => openTaskModal(t.group_task_id, { readOnly: true }).catch(showError),
          }, 'Obre'))))))));
  }

  append(view, 
    h('div', { class: 'page-header' },
      h('div', { class: 'titles' },
        h('h1', {}, 'Tasques bloquejades'),
        h('p', { class: 'muted' }, 'Tasques bloquejades ara mateix als projectes actius que supervises.'))),
    holder
  );
  await load();

  // Blocking durations keep growing while the page is open.
  const timer = setInterval(() => {
    if (!holder.isConnected) return clearInterval(timer);
    return draw();
  }, 30000);
}

const taskLink = (row) => h('a', { href: `#/groups/${row.group_id}/task/${row.group_task_id}` }, row.title);

function section(title, rows, emptyText, hint) {
  return h('div', { class: 'card' },
    h('h2', {}, `${title} (${rows.length})`),
    hint ? h('p', { class: 'muted' }, hint) : null,
    rows.length ? h('ul', { class: 'timeline' }, rows) : h('p', { class: 'muted' }, emptyText));
}

export async function renderContributions(view, [projectId, studentId]) {
  const [project, data] = await Promise.all([
    api.get(`/api/projects/${projectId}`),
    api.get(`/api/projects/${projectId}/students/${studentId}/contributions`),
  ]);

  append(view, 
    h('div', { class: 'page-header' },
      h('div', { class: 'titles' },
        h('div', { class: 'breadcrumb' },
          h('a', { href: '#/' }, 'Projectes'), ' / ',
          h('a', { href: `#/projects/${project.id}/students` }, project.name)),
        h('h1', {}, data.student.name),
        h('div', { class: 'meta', style: { 'margin-top': '6px' } },
          h('span', {}, data.student.email),
          data.group
            ? h('a', { href: `#/groups/${data.group.id}` }, `Grup ${data.group.group_number}`)
            : h('span', {}, 'Actualment sense grup en aquest projecte')))),
    h('div', { class: 'notice' },
      'Ser responsable d\'una tasca no demostra haver-ne fet tota la feina. Aquesta vista separa la responsabilitat de les accions realment registrades (finalitzacions, comentaris i bloquejos).'),

    section('Tasques de les quals és responsable', data.assigned.map((t) =>
      h('li', {},
        h('div', { class: 'head' }, taskLink(t), statusBadge(t.status)),
        h('div', { class: 'muted' },
          t.assigned_at ? `Responsable des del ${formatDateTime(t.assigned_at)}` : '',
          t.status === 'completed' && t.completed_by_name ? ` · finalitzada per ${t.completed_by_name}` : ''))),
      'No és responsable de cap tasca.'),

    section('Tasques on col·labora', data.collaborating.map((t) =>
      h('li', {},
        h('div', { class: 'head' }, taskLink(t), statusBadge(t.status)),
        h('div', { class: 'muted' }, `Responsable: ${t.responsible_name || 'ningú'} · col·labora des del ${formatDateTime(t.collaborator_since)}`))),
      'No col·labora en cap tasca.',
      "Tasques d'una altra persona on la responsable l'ha afegit com a col·laborador/a."),

    section('Tasques que ha finalitzat', data.completed.map((t) =>
      h('li', {},
        h('div', { class: 'head' }, taskLink(t), h('span', { class: 'when' }, formatDateTime(t.completed_at))),
        h('div', { class: 'muted' }, `Responsable: ${t.responsible_name || 'ningú'}`))),
      'No ha finalitzat cap tasca.',
      'Tasques marcades com a finalitzades per aquesta persona, sigui o no la responsable.'),

    section('Bloquejos', data.block_events.map((e) =>
      h('li', { class: e.unblocked_at ? '' : 'event-block' },
        h('div', { class: 'head' },
          taskLink(e),
          h('span', { class: 'when' }, e.unblocked_at ? `Resolt · ${formatDuration(e.duration_seconds)}` : `Actiu · fa ${formatDuration(secondsSince(e.blocked_at))}`)),
        h('div', { class: 'text' }, e.reason),
        h('div', { class: 'muted' }, `Bloquejada per ${e.blocked_by_name} · ${formatDateTime(e.blocked_at)}`))),
      'No té bloquejos.',
      'Bloquejos que ha obert, i bloquejos actius de tasques de les quals és responsable.'),

    section('Comentaris escrits', data.comments.map((c) =>
      h('li', {},
        h('div', { class: 'head' }, taskLink(c), h('span', { class: 'when' }, formatDateTime(c.created_at))),
        h('div', { class: 'text' }, c.content))),
      'No ha escrit cap comentari.'),

    section('Canvis de responsabilitat', data.transfers.map((e) => historyItem(e, { withTask: true })),
      'No hi ha canvis de responsabilitat.'),

    section('Activitat recent', data.activity.map((e) => historyItem(e, { withTask: true })),
      'Encara no hi ha activitat registrada.')
  );
}
