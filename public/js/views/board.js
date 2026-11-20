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
  // The card just dropped ({ id, x, y }: the task and the centre of where it was
  // left): when the board is drawn again it glides from there to its place.
  let landed = null;
  let everShown = false;
  // Resolves when the glide of the last dropped card is over.
  let landing = Promise.resolve();
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

  // ---- Dragging a card to another column ------------------------------------------
  // Done with pointer events, so the same code serves a mouse, a pen and a
  // finger. With a mouse the drag starts as soon as the card is pulled; on a
  // touch screen it starts after a long press, so that a plain swipe still
  // scrolls the board. The card lifts (a little bigger, a deeper shadow) to
  // show it is being carried, and a dimmed copy stays in the place it left.
  const LONG_PRESS_MS = 350;
  const PULL_PX = 5; // Mouse: how far the card is pulled before it lifts.
  const SLOP_PX = 10; // Touch: moving this far before the long press is a scroll.
  let drag = null; // { task, el, ghost, pointerId, x, y, startX, startY, originX, originY, frame }

  const allowedHere = (status) => drag.task.status !== status && drag.task.allowed_transitions.includes(status);
  const columnAt = (x, y) => [...boardEl.querySelectorAll('.column')].find((col) => {
    const box = col.getBoundingClientRect();
    return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
  });

  function trackDrag() {
    drag.el.style.setProperty('transform', `translate(${drag.x - drag.startX}px, ${drag.y - drag.startY}px)`);
    const over = columnAt(drag.x, drag.y);
    const status = over && allowedHere(over.dataset.status) ? over.dataset.status : null;
    if (status === dragTarget) return;
    boardEl.querySelectorAll('.drop-ok').forEach((col) => col.classList.remove('drop-ok'));
    if (status) over.classList.add('drop-ok');
    announceDrag(status);
  }

  // Near an edge the board (sideways) and the page (up and down) scroll by themselves.
  function autoScroll() {
    if (!drag) return;
    const edge = 60;
    const speed = (distance) => Math.ceil(distance / 5);
    const box = boardEl.getBoundingClientRect();
    if (drag.x < Math.max(box.left, 0) + edge) boardEl.scrollLeft -= speed(Math.max(box.left, 0) + edge - drag.x);
    else if (drag.x > Math.min(box.right, window.innerWidth) - edge) boardEl.scrollLeft += speed(drag.x - (Math.min(box.right, window.innerWidth) - edge));
    if (drag.y < edge) window.scrollBy(0, -speed(edge - drag.y));
    else if (drag.y > window.innerHeight - edge) window.scrollBy(0, speed(drag.y - (window.innerHeight - edge)));
    trackDrag();
    drag.frame = requestAnimationFrame(autoScroll);
  }

  function lift(el, task, event) {
    const box = el.getBoundingClientRect();
    // The copy keeps the card's place in the column while the card itself
    // is carried above everything else.
    const ghost = el.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.removeAttribute('data-task');
    el.before(ghost);
    for (const [prop, value] of Object.entries({ left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` })) {
      el.style.setProperty(prop, value);
    }
    el.classList.add('lifted');
    document.body.classList.add('reordering');
    dragged = task;
    drag = { task, el, ghost, pointerId: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY };
    try {
      el.setPointerCapture(event.pointerId);
    } catch {
      // A pointer the browser no longer knows: the drag simply never moves.
    }
    boardEl.querySelectorAll('.column').forEach((col) => allowedHere(col.dataset.status) && col.classList.add('drop-allowed'));
    announceDrag(null);
    // Repeated while the drag lasts, so a lost "it ended" cannot leave the
    // card marked on the other screens for ever.
    dragBeat = setInterval(() => announceDrag(dragTarget), 5000);
    drag.frame = requestAnimationFrame(autoScroll);
  }

  // Ends the drag. With a column to drop on, the task moves there; without
  // one (cancelled, or dropped where it cannot go) the card glides back.
  function drop(commit) {
    if (!drag) return;
    const { task, el, ghost } = drag;
    const target = commit ? dragTarget : null;
    cancelAnimationFrame(drag.frame);
    clearInterval(dragBeat);
    if (channel) channel.send({ type: 'drag_end' });
    drag = null;
    dragged = null;
    dragTarget = null;
    document.body.classList.remove('reordering');
    boardEl.querySelectorAll('.drop-ok, .drop-allowed').forEach((col) => col.classList.remove('drop-ok', 'drop-allowed'));
    // The click that ends a drag must not open the task.
    const swallow = (event) => { event.stopPropagation(); event.preventDefault(); };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 50);

    const settle = () => {
      ghost.remove();
      el.classList.remove('lifted', 'returning');
      for (const prop of ['left', 'top', 'width', 'height', 'transform']) el.style.removeProperty(prop);
    };
    if (target) {
      // The card stays where it was dropped, still lifted, while the server
      // is asked. When the board is drawn again it glides from there to its
      // place: in the new column, or back in the old one if the move was
      // refused or cancelled.
      const box = el.getBoundingClientRect();
      landed = { id: task.id, x: box.left + box.width / 2, y: box.top + box.height / 2 };
      (target === 'blocked' ? blockAfterLanding(task) : move(task, target)).finally(() => {
        // Not drawn again (the board could not be read): put it back.
        if (el.isConnected) {
          settle();
          landed = null;
        }
      });
    } else {
      el.classList.add('returning');
      el.style.setProperty('transform', 'translate(0px, 0px)');
      setTimeout(() => {
        settle();
        resumeRemote();
      }, 170);
    }
  }

  // A press that may still become a drag: { el, task, pointerId, x, y, touch, timer }
  let pending = null;
  const forget = () => {
    if (pending) {
      clearTimeout(pending.timer);
      pending.el.classList.remove('pressed');
    }
    pending = null;
  };
  const liftPending = () => {
    const start = pending;
    forget();
    if (start.el.isConnected) lift(start.el, start.task, { pointerId: start.pointerId, clientX: start.x, clientY: start.y });
  };

  // The dropped card glides from where it was left to its place on the board,
  // settling back to its size on the way.
  function land(cardEl, from) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !cardEl.animate) return;
    const box = cardEl.getBoundingClientRect();
    const dx = from.x - (box.left + box.width / 2);
    const dy = from.y - (box.top + box.height / 2);
    cardEl.classList.add('landing');
    const style = getComputedStyle(document.documentElement);
    const gliding = cardEl.animate(
      [
        { translate: `${dx}px ${dy}px`, scale: '1.05', boxShadow: style.getPropertyValue('--shadow-lg') },
        { translate: '0px 0px', scale: '1', boxShadow: style.getPropertyValue('--shadow-sm') },
      ],
      // Longer for a longer way, within limits.
      { duration: Math.min(360, 180 + Math.hypot(dx, dy) / 4), easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }
    );
    const done = () => cardEl.classList.remove('landing');
    gliding.addEventListener('finish', done);
    gliding.addEventListener('cancel', done);
    landing = gliding.finished.catch(() => {});
  }

  const centreOf = (taskId) => {
    const cardEl = boardEl.querySelector(`.task-card[data-task="${taskId}"]`);
    if (!cardEl) return null;
    const box = cardEl.getBoundingClientRect();
    return { id: taskId, x: box.left + box.width / 2, y: box.top + box.height / 2 };
  };

  // A card dropped on "Bloquejat" first lands there, and only then is the
  // reason asked. If the reason is not given (or the server refuses), the
  // card glides back to the place it came from.
  async function blockAfterLanding(task) {
    const from = task.status;
    task.status = 'blocked'; // Only on screen, until the server confirms it.
    landing = Promise.resolve();
    draw();
    await landing;
    let updated = null;
    try {
      updated = await changeTaskStatus({ ...task, status: from }, 'blocked');
    } catch (err) {
      showError(err);
    }
    if (!updated) {
      task.status = from;
      landed = centreOf(task.id);
    }
    // Always re-read: the server is the source of truth.
    await refresh().catch(() => draw());
  }

  function enableDrag(el, task) {
    el.addEventListener('pointerdown', (event) => {
      if (drag || pending || (event.pointerType === 'mouse' && event.button !== 0)) return;
      // The "Mou a…" list keeps working as a list.
      if (event.target.closest('select, a')) return;
      pending = { el, task, pointerId: event.pointerId, x: event.clientX, y: event.clientY, touch: event.pointerType !== 'mouse', timer: null };
      // With a mouse the card lifts as soon as it is pressed, before it moves,
      // like the handle of the task list. A finger has to wait for the long
      // press: lifting at once would make every scroll flash the cards.
      if (!pending.touch) el.classList.add('pressed');
      if (pending.touch) {
        pending.timer = setTimeout(() => {
          if (navigator.vibrate) navigator.vibrate(15);
          liftPending();
        }, LONG_PRESS_MS);
      }
    });
    // While a card is carried by a finger the page must not scroll under it,
    // and a long press must not open the system menu.
    el.addEventListener('touchmove', (event) => { if (drag && drag.el === el && event.cancelable) event.preventDefault(); }, { passive: false });
    el.addEventListener('contextmenu', (event) => { if ((pending && pending.el === el) || (drag && drag.el === el)) event.preventDefault(); });
  }

  // The rest of the gesture is followed on the whole page: a quick pull takes
  // the pointer off the card before it has lifted.
  const onPointerMove = (event) => {
    if (drag && event.pointerId === drag.pointerId) {
      drag.x = event.clientX;
      drag.y = event.clientY;
      trackDrag();
      return;
    }
    if (!pending || event.pointerId !== pending.pointerId) return;
    const moved = Math.hypot(event.clientX - pending.x, event.clientY - pending.y);
    if (pending.touch) {
      // A swipe: the browser scrolls, and this press is not a drag.
      if (moved > SLOP_PX) forget();
    } else if (moved > PULL_PX) {
      liftPending();
      if (!drag) return;
      drag.x = event.clientX;
      drag.y = event.clientY;
      trackDrag();
    }
  };
  const onPointerEnd = (event) => {
    if (pending && event.pointerId === pending.pointerId) forget();
    if (drag && event.pointerId === drag.pointerId) drop(event.type === 'pointerup');
  };
  const cancelOnEscape = (event) => {
    if (event.key === 'Escape' && drag) drop(false);
  };
  const pageListeners = [['pointermove', onPointerMove], ['pointerup', onPointerEnd], ['pointercancel', onPointerEnd], ['keydown', cancelOnEscape]];
  for (const [type, listener] of pageListeners) document.addEventListener(type, listener);
  // The listeners go away with the board they belong to.
  const tidy = setInterval(() => {
    if (boardEl.isConnected || drag || !everShown) return;
    clearInterval(tidy);
    for (const [type, listener] of pageListeners) document.removeEventListener(type, listener);
  }, 5000);

  function card(task) {
    const canMove = canEdit() && task.allowed_transitions.length > 0;
    const moveSelect = canMove
      ? h('select', { 'aria-label': `Canvia l'estat de «${task.title}»` },
          h('option', { value: '' }, 'Mou a…'),
          task.allowed_transitions.map((s) => h('option', { value: s }, STATUS_LABELS[s])))
      : null;
    if (moveSelect) moveSelect.addEventListener('change', () => moveSelect.value && move(task, moveSelect.value, moveSelect));

    const el = h('article', { class: `task-card ${task.status}${canMove ? ' can-drag' : ''}`, 'data-task': String(task.id) },
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

    if (canMove) enableDrag(el, task);
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
    if (landed !== null) {
      const cardEl = boardEl.querySelector(`.task-card[data-task="${landed.id}"]`);
      if (cardEl) land(cardEl, landed);
      landed = null;
    }
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
    everShown = true;
    if (boardEl.isConnected) channel = openBoardChannel(Number(groupId), handlers);
  }, 0);

  if (openTaskId) openTask(Number(openTaskId));
}
