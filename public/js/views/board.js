// Group Kanban board: four status columns, drag-and-drop plus an accessible
// "move to" control on every card. Cards always follow the global task order.
import { api } from '../api.js';
import { openBoardChannel } from '../realtime.js';
import {
  append, avatar, clear, formatDateTime, groupLabel, h, icon, modal, toggleSwitch, tagChips, promptDialog, run, showError, STATUS_LABELS, STATUSES, toast,
} from '../ui.js';
import { changeTaskStatus, openTaskModal } from './taskModal.js';

export async function renderBoard(view, [groupId, openTaskId], { user, rerender }) {
  let board = await api.get(`/api/groups/${groupId}/board`);
  const boardEl = h('div', { class: 'board' });
  const infoEl = h('div', { class: 'board-info' });
  const peopleEl = h('span', { class: 'board-people' });
  let dragged = null;
  let channel = null;
  // What the other people on this board are doing right now (real time).
  let people = [];
  const remoteDrags = new Map(); // user id -> { user, task_id, status, timer }
  let dragTarget = null;
  let dragBeat = null;
  // Teachers and administrators see the board read-only until they switch
  // editing on, so a group's work is never changed by a stray click or drag.
  // Students always work on their own board. Editing is off again every time
  // the board is opened.
  let editing = !board.can_manage;
  const canEdit = () => editing && board.project.status === 'active';

  let reads = 0;
  async function refresh() {
    const read = ++reads;
    const fresh = await api.get(`/api/groups/${groupId}/board`);
    if (read !== reads) return; // A newer read is on its way.
    board = fresh;
    draw();
  }

  // ---- Real time ---------------------------------------------------------------

  // Somebody else changed the board. Redrawing would cancel a drag or close
  // an open "Mou a…" list, so it waits until those are over.
  let remotePending = false;
  let remoteTimer = null;
  const busy = () => dragged || (boardEl.contains(document.activeElement) && document.activeElement.tagName === 'SELECT');
  function remoteChange() {
    clearTimeout(remoteTimer);
    remoteTimer = setTimeout(async () => {
      if (!boardEl.isConnected) return;
      if (busy()) {
        remotePending = true;
        return;
      }
      remotePending = false;
      try {
        await refresh();
      } catch (err) {
        // The board is no longer theirs to see (hidden project, changed group).
        if (err.status === 403 || err.status === 404) rerender();
      }
    }, 200);
  }
  const resumeRemote = () => remotePending && remoteChange();
  boardEl.addEventListener('focusout', () => setTimeout(resumeRemote, 0));

  // Marks the cards other people are dragging, and where they are heading.
  function paintRemote() {
    boardEl.querySelectorAll('.remote-drag').forEach((el) => el.classList.remove('remote-drag'));
    boardEl.querySelectorAll('.remote-target').forEach((el) => el.classList.remove('remote-target'));
    boardEl.querySelectorAll('.remote-note').forEach((el) => el.remove());
    for (const drag of remoteDrags.values()) {
      const cardEl = boardEl.querySelector(`.task-card[data-task="${drag.task_id}"]`);
      if (!cardEl) continue;
      cardEl.classList.add('remote-drag');
      cardEl.append(h('div', { class: 'remote-note' }, avatar(drag.user.name),
        drag.status ? `${drag.user.name} la mou cap a «${STATUS_LABELS[drag.status]}»` : `${drag.user.name} l'està movent`));
      const columnEl = drag.status ? boardEl.querySelector(`.column[data-status="${drag.status}"]`) : null;
      if (columnEl) columnEl.classList.add('remote-target');
    }
  }

  function paintPeople() {
    const others = people.filter((person) => person.id !== user.id);
    append(clear(peopleEl), others.length
      ? [h('strong', {}, 'Ara al tauler: '), others.map((person) => h('span', { class: 'person-here' }, avatar(person.name), person.name))]
      : null);
  }

  function forgetDrag(userId) {
    const drag = remoteDrags.get(userId);
    if (!drag) return;
    clearTimeout(drag.timer);
    remoteDrags.delete(userId);
    paintRemote();
  }

  // Tells the others which card is being dragged here and over which column.
  function announceDrag(status) {
    if (!dragged || !channel) return;
    dragTarget = status;
    channel.send({ type: 'drag', task_id: dragged.id, status });
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

    const el = h('article', { class: `task-card ${task.status}`, 'data-task': String(task.id), draggable: canMove ? 'true' : null },
      h('div', { class: 'task-head' },
        h('button', { class: 'task-title', type: 'button', onClick: () => openTask(task.id) }, task.title),
        // The task's number in the project's order, as in the list and the matrix.
        h('span', { class: 'task-number', title: `Tasca número ${task.position}` },
          h('span', { class: 'sr-only' }, 'Tasca número '), String(task.position))),
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
        announceDrag(null);
        // Repeated while the drag lasts, so a lost "it ended" cannot leave
        // the card marked on the other screens for ever.
        dragBeat = setInterval(() => announceDrag(dragTarget), 5000);
      });
      el.addEventListener('dragend', () => {
        dragged = null;
        dragTarget = null;
        clearInterval(dragBeat);
        if (channel) channel.send({ type: 'drag_end' });
        el.classList.remove('dragging');
        boardEl.querySelectorAll('.drop-ok').forEach((c) => c.classList.remove('drop-ok'));
        resumeRemote();
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
    const el = h('section', { class: `column ${status}`, 'data-status': status, 'aria-label': STATUS_LABELS[status] },
      h('div', { class: 'column-header' },
        h('h2', {}, icon(status), STATUS_LABELS[status]),
        h('span', { class: 'count', 'aria-label': `${tasks.length} tasques` }, String(tasks.length))),
      tasks.length ? tasks.map(card) : h('div', { class: 'column-empty' }, 'Cap tasca'));

    const accepts = () => dragged && dragged.status !== status && dragged.allowed_transitions.includes(status);
    el.addEventListener('dragover', (event) => {
      if (!accepts()) return;
      event.preventDefault();
      el.classList.add('drop-ok');
      if (dragTarget !== status) announceDrag(status);
    });
    el.addEventListener('dragleave', (event) => {
      if (el.contains(event.relatedTarget)) return;
      el.classList.remove('drop-ok');
      if (dragTarget === status) announceDrag(null);
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

    const webButton = h('button', { class: 'btn small', type: 'button' }, group.web_url ? 'Canvia' : 'Configura la web');
    webButton.addEventListener('click', async () => {
      const url = await promptDialog({
        title: 'Web del grup',
        label: 'URL de la web',
        hint: "L'adreça on es pot veure la feina publicada, per exemple https://exemple.cat. Deixa-ho buit per treure-la.",
        value: group.web_url || '',
        required: false,
      });
      if (url === null) return;
      await run(webButton, async () => {
        await api.put(`/api/groups/${group.id}/web`, { web_url: url });
        toast('Web actualitzada.');
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
        canSetGithub ? githubButton : null),
      h('span', {},
        h('strong', {}, 'Web: '),
        group.web_url
          ? h('a', { href: group.web_url, target: '_blank', rel: 'noopener noreferrer' }, group.web_url.replace(/^https?:\/\//, '').replace(/\/$/, ''))
          : 'sense web',
        ' ',
        canSetGithub ? webButton : null),
      peopleEl
    );
    append(clear(boardEl), STATUSES.map(column));
    paintRemote();
  }

  // The project description, for students (staff read it in the project page).
  function showDescription() {
    modal({
      title: board.project.name,
      wide: true,
      // Never taller than the window: a long description scrolls inside.
      fit: true,
      body: board.project.description_html
        ? h('div', { class: 'tab-scroll', tabindex: '0' }, h('div', { class: 'markdown', html: board.project.description_html }))
        : h('p', { class: 'muted' }, 'Aquest projecte no té descripció.'),
    });
  }

  append(view, 
    h('div', { class: 'page-header' },
      h('div', { class: 'titles' },
        h('div', { class: 'breadcrumb' },
          h('a', { href: '#/' }, user.role === 'student' ? 'Els meus projectes' : 'Projectes'), ' / ',
          // Students have no project page: the board is their whole view.
          board.can_manage ? h('a', { href: `#/projects/${board.project.id}` }, board.project.name) : board.project.name),
        h('h1', {}, groupLabel(board.group.group_number, board.group.name))),
      h('div', { class: 'actions' },
        board.project.hidden ? h('span', { class: 'tag hidden-tag' }, 'Ocult als estudiants') : null,
        board.project.status === 'archived' ? h('span', { class: 'tag' }, 'Projecte arxivat · només lectura') : null,
        board.can_manage && board.project.status === 'active'
          ? toggleSwitch("Permet l'edició", editing, (on) => { editing = on; draw(); })
          : null,
        !board.can_manage && board.project.ranking_visible
          ? h('a', { class: 'btn', href: `#/projects/${board.project.id}/ranking` }, '🤝 Insígnies')
          : null,
        board.can_manage ? null : h('button', { class: 'btn', type: 'button', onClick: showDescription }, 'Descripció'))),
    infoEl,
    board.tasks.length === 0 ? h('div', { class: 'notice' }, 'Aquest projecte encara no té tasques.') : null,
    boardEl
  );
  draw();

  // Opened once the board is really on screen: a board that lost the race
  // against a newer navigation must not take the channel from the new page.
  const handlers = {
    onChange: remoteChange,
    onPeople(list) {
      people = list;
      paintPeople();
    },
    onDrag(drag) {
      if (drag.user.id === user.id) return; // The same person in another tab.
      const previous = remoteDrags.get(drag.user.id);
      if (previous) clearTimeout(previous.timer);
      remoteDrags.set(drag.user.id, { ...drag, timer: setTimeout(() => forgetDrag(drag.user.id), 15000) });
      paintRemote();
    },
    onDragEnd: forgetDrag,
    onOffline() {
      people = [];
      paintPeople();
      for (const userId of [...remoteDrags.keys()]) forgetDrag(userId);
    },
    onDenied: rerender,
  };
  setTimeout(() => {
    if (boardEl.isConnected) channel = openBoardChannel(Number(groupId), handlers);
  }, 0);

  if (openTaskId) openTask(Number(openTaskId));
}
