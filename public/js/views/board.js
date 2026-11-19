// Group Kanban board: four status columns, drag-and-drop plus an accessible
// "move to" control on every card. Cards always follow the global task order.
import { api } from '../api.js';
import {
  append, avatar, clear, formatDateTime, h, icon, toggleSwitch, tagChips, promptDialog, run, showError, STATUS_LABELS, STATUSES, toast,
} from '../ui.js';
import { changeTaskStatus, openTaskModal } from './taskModal.js';

export async function renderBoard(view, [groupId, openTaskId], { user }) {
  let board = await api.get(`/api/groups/${groupId}/board`);
  const boardEl = h('div', { class: 'board' });
  const infoEl = h('div', { class: 'board-info' });
  let dragged = null;
  // Teachers and administrators see the board read-only until they switch
  // editing on, so a group's work is never changed by a stray click or drag.
  // Students always work on their own board. Editing is off again every time
  // the board is opened.
  let editing = !board.can_manage;
  const canEdit = () => editing && board.project.status === 'active';

  async function refresh() {
    board = await api.get(`/api/groups/${groupId}/board`);
    draw();
  }

  async function move(task, status, control) {
    try {
      const updated = await changeTaskStatus(task, status);
      if (!updated && control) control.value = '';
    } catch (err) {
      showError(err);
    }
    // Always re-read: the server is the source of truth, also after a conflict.
    await refresh().catch(showError);
  }

  let opening = false;
  function openTask(id) {
    if (opening) return; // Ignore double clicks while the dialog loads.
    opening = true;
    openTaskModal(id, { onChange: () => refresh().catch(showError), readOnly: !canEdit() })
      .catch(showError)
      .finally(() => { opening = false; });
  }

  function card(task) {
    const canMove = canEdit() && task.allowed_transitions.length > 0;
    const moveSelect = canMove
      ? h('select', { 'aria-label': `Canvia l'estat de «${task.title}»` },
          h('option', { value: '' }, 'Mou a…'),
          task.allowed_transitions.map((s) => h('option', { value: s }, STATUS_LABELS[s])))
      : null;
    if (moveSelect) moveSelect.addEventListener('change', () => moveSelect.value && move(task, moveSelect.value, moveSelect));

    const el = h('article', { class: `task-card ${task.status}`, draggable: canMove ? 'true' : null },
      h('button', { class: 'task-title', type: 'button', onClick: () => openTask(task.id) }, task.title),
      tagChips(task.tags),
      task.status === 'blocked' && task.block_reason
        ? h('div', { class: 'block-reason', title: task.block_reason }, icon('blocked'),
            h('span', {}, h('span', { class: 'sr-only' }, 'Motiu del bloqueig: '), task.block_reason))
        : null,
      h('div', { class: 'task-footer' },
        h('div', { class: 'who' },
          task.responsible
            ? [avatar(task.responsible.name), h('span', { title: `Responsable: ${task.responsible.name}` }, task.responsible.name),
               task.collaborators.length > 0
                 ? h('span', { class: 'tag', title: `Col·laboren: ${task.collaborators.map((c) => c.name).join(', ')}` },
                     `+${task.collaborators.length}`, h('span', { class: 'sr-only' }, ' col·laboradors'))
                 : null]
            : h('span', {}, 'Sense responsable')),
        h('div', { class: 'counts' },
          h('span', { title: 'Comentaris' }, icon('comment'), String(task.comment_count), h('span', { class: 'sr-only' }, ' comentaris')))),
      task.status === 'completed' && task.completed_at
        ? h('div', { class: 'muted', style: { 'font-size': '0.8rem', 'margin-top': '6px' } },
            `Finalitzada el ${formatDateTime(task.completed_at)}`,
            task.completed_by && (!task.responsible || task.completed_by.id !== task.responsible.id)
              ? ` per ${task.completed_by.name}`
              : '')
        : null,
      moveSelect ? h('div', { class: 'task-move' }, moveSelect) : null);

    if (canMove) {
      el.addEventListener('dragstart', (event) => {
        dragged = task;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', String(task.id));
        el.classList.add('dragging');
      });
      el.addEventListener('dragend', () => {
        dragged = null;
        el.classList.remove('dragging');
        boardEl.querySelectorAll('.drop-ok').forEach((c) => c.classList.remove('drop-ok'));
      });
    }
    return el;
  }

  function column(status) {
    const tasks = board.tasks.filter((t) => t.status === status);
    // "Finalitzat" lists tasks in the order they were completed (first one
    // on top). Every other column keeps the global project order.
    if (status === 'completed') {
      tasks.sort((a, b) => new Date(a.completed_at) - new Date(b.completed_at) || a.sort_order - b.sort_order);
    }
    const el = h('section', { class: `column ${status}`, 'aria-label': STATUS_LABELS[status] },
      h('div', { class: 'column-header' },
        h('h2', {}, icon(status), STATUS_LABELS[status]),
        h('span', { class: 'count', 'aria-label': `${tasks.length} tasques` }, String(tasks.length))),
      tasks.length ? tasks.map(card) : h('div', { class: 'column-empty' }, 'Cap tasca'));

    const accepts = () => dragged && dragged.status !== status && dragged.allowed_transitions.includes(status);
    el.addEventListener('dragover', (event) => {
      if (!accepts()) return;
      event.preventDefault();
      el.classList.add('drop-ok');
    });
    el.addEventListener('dragleave', (event) => {
      if (!el.contains(event.relatedTarget)) el.classList.remove('drop-ok');
    });
    el.addEventListener('drop', (event) => {
      if (!accepts()) return;
      event.preventDefault();
      el.classList.remove('drop-ok');
      move(dragged, status);
    });
    return el;
  }

  function draw() {
    const { group } = board;
    const canSetGithub = canEdit() && board.access !== 'teacher';
    const githubButton = h('button', { class: 'btn small', type: 'button' }, group.github_url ? 'Canvia' : 'Configura el repositori');
    githubButton.addEventListener('click', async () => {
      const url = await promptDialog({
        title: 'Repositori de GitHub del grup',
        label: 'URL del repositori',
        hint: 'Per exemple: https://github.com/usuari/repositori. Deixa-ho buit per treure\'l.',
        value: group.github_url || '',
        required: false,
      });
      if (url === null) return;
      await run(githubButton, async () => {
        await api.put(`/api/groups/${group.id}/github`, { github_url: url });
        toast('Repositori actualitzat.');
        await refresh();
      });
    });

    append(clear(infoEl), 
      h('span', {}, h('strong', {}, 'Membres: '), board.members.map((m) => m.name).join(', ') || '—'),
      h('span', {},
        h('strong', {}, 'GitHub: '),
        group.github_url
          ? h('a', { href: group.github_url, target: '_blank', rel: 'noopener noreferrer' }, group.github_url.replace('https://github.com/', ''))
          : 'sense repositori',
        ' ',
        canSetGithub ? githubButton : null)
    );
    append(clear(boardEl), STATUSES.map(column));
  }

  append(view, 
    h('div', { class: 'page-header' },
      h('div', { class: 'titles' },
        h('div', { class: 'breadcrumb' },
          h('a', { href: '#/' }, user.role === 'student' ? 'Els meus projectes' : 'Projectes'), ' / ',
          h('a', { href: `#/projects/${board.project.id}` }, board.project.name)),
        h('h1', {}, `Grup ${board.group.group_number}`)),
      board.project.status === 'archived'
        ? h('span', { class: 'tag' }, 'Projecte arxivat · només lectura')
        : board.can_manage
          ? toggleSwitch("Permet l'edició", editing, (on) => { editing = on; draw(); })
          : null),
    infoEl,
    board.tasks.length === 0 ? h('div', { class: 'notice' }, 'Aquest projecte encara no té tasques.') : null,
    boardEl
  );
  draw();

  if (openTaskId) openTask(Number(openTaskId));
}
