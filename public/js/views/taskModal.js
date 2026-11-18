// Group task detail dialog: description, state, responsibility, comments,
// blocking events and activity history.
import { api } from '../api.js';
import {
  append, avatar, clear, EVENT_LABELS, formatDateTime, formatDuration, h, icon, modal, moduleChips,
  promptDialog, run, secondsSince, STATUS_LABELS, statusBadge, toast,
} from '../ui.js';

const ACTION_LABELS = {
  'pending>in_progress': 'Comença la tasca',
  'blocked>in_progress': 'Desbloqueja la tasca',
  'completed>in_progress': 'Reobre la tasca',
};

// Changes a task state, asking for the mandatory reason when blocking.
// Returns the updated detail, or null when cancelled.
export async function changeTaskStatus(task, status) {
  const body = { status, expected_status: task.status };
  if (status === 'blocked') {
    const reason = await promptDialog({
      title: 'Bloqueja la tasca',
      label: 'Motiu del bloqueig',
      hint: 'Explica què impedeix avançar. És obligatori.',
      confirmLabel: 'Bloqueja',
      multiline: true,
    });
    if (reason === null) return null;
    body.reason = reason;
  }
  const updated = await api.post(`/api/group-tasks/${task.id}/status`, body);
  if (status === 'completed') toast('Tasca finalitzada.');
  else if (task.status === 'pending' && status === 'in_progress' && !task.responsible && updated.responsible) {
    toast(`Tasca començada. Responsable: ${updated.responsible.name}.`);
  }
  return updated;
}

// The detail line of a history event: a state change shown as two status
// badges, or who the responsibility moved from and to.
function historyDetail(event) {
  if (event.event_type === 'responsibility_transferred' || event.event_type === 'auto_assigned') {
    const from = event.old_user_name || (event.old_value ? 'usuari eliminat' : 'ningú');
    const to = event.new_user_name || (event.new_value ? 'usuari eliminat' : 'ningú');
    return h('span', { class: 'muted' }, event.event_type === 'auto_assigned' ? `Responsable: ${to}` : `${from} → ${to}`);
  }
  if (STATUS_LABELS[event.old_value] && STATUS_LABELS[event.new_value]) {
    return h('span', { class: 'state-change' },
      statusBadge(event.old_value),
      h('span', { 'aria-hidden': 'true' }, '→'),
      h('span', { class: 'sr-only' }, ' passa a '),
      statusBadge(event.new_value));
  }
  return null;
}

export function historyItem(event, { withTask = false } = {}) {
  const detail = historyDetail(event);
  return h('li', {},
    h('div', { class: 'head' },
      h('strong', {}, event.actor_name),
      h('span', {}, EVENT_LABELS[event.event_type] || event.event_type),
      h('span', { class: 'when' }, formatDateTime(event.created_at))),
    detail || withTask
      ? h('div', { class: 'history-detail' },
          withTask ? h('span', { class: 'muted' }, `${event.title} · Grup ${event.group_number}`) : null,
          detail)
      : null);
}

export async function openTaskModal(groupTaskId, { onChange = () => {} } = {}) {
  let task = await api.get(`/api/group-tasks/${groupTaskId}`);
  let activeTab = 'description';
  const content = h('div', { class: 'task-detail' });
  const dialog = modal({ title: task.title, body: content, wide: true, fit: true });

  const update = (updated) => {
    if (!updated) return;
    task = updated;
    render();
    onChange(task);
  };

  function sidePanel() {
    // Moves out of "En curs" (back to pending, block, complete) are made on
    // the board itself; the dialog offers the remaining ones.
    const stateButtons = task.status === 'in_progress' ? [] : task.allowed_transitions.map((target) => {
      const key = `${task.status}>${target}`;
      const button = h('button', { class: `btn ${ACTION_LABELS[key] ? 'primary' : ''}`, type: 'button' },
        ACTION_LABELS[key] || `Mou a «${STATUS_LABELS[target]}»`);
      button.addEventListener('click', () => run(button, async () => update(await changeTaskStatus(task, target))));
      return button;
    });

    let transfer = null;
    if (task.can_transfer) {
      const candidates = task.members.filter((m) => !task.responsible || m.id !== task.responsible.id);
      const select = h('select', { 'aria-label': 'Nova persona responsable' },
        h('option', { value: '' }, 'Tria una persona…'),
        candidates.map((m) => h('option', { value: String(m.id) }, m.name)),
        task.can_manage && task.responsible ? h('option', { value: 'none' }, '— Sense responsable —') : null);
      const button = h('button', { class: 'btn', type: 'button' }, task.responsible ? 'Transfereix la responsabilitat' : 'Assigna responsable');
      button.addEventListener('click', () => {
        if (!select.value) return select.focus();
        return run(button, async () => {
          const updated = await api.post(`/api/group-tasks/${task.id}/responsible`, {
            user_id: select.value === 'none' ? null : Number(select.value),
          });
          toast(updated.responsible ? `Nova persona responsable: ${updated.responsible.name}.` : 'La tasca ha quedat sense responsable.');
          update(updated);
        });
      });
      transfer = h('div', { class: 'stack' }, select, button);
    }

    return h('aside', { class: 'detail-side' },
      h('section', {},
        h('h3', {}, 'Estat'),
        h('div', { class: 'person' }, statusBadge(task.status)),
        task.block_reason ? h('div', { class: 'block-reason' }, icon('blocked'), h('span', {}, task.block_reason)) : null,
        stateButtons.length ? h('div', { class: 'stack' }, stateButtons) : null,
        task.project.status === 'archived' ? h('p', { class: 'muted' }, 'Projecte arxivat: només lectura.') : null),
      h('section', {},
        h('h3', {}, 'Responsable'),
        task.responsible
          ? h('div', { class: 'person' }, avatar(task.responsible.name), h('span', {}, task.responsible.name))
          : h('p', { class: 'muted' }, 'Sense responsable. Qui comenci la tasca en serà responsable.'),
        transfer),
      task.status === 'completed' && task.completed_by
        ? h('section', {},
            h('h3', {}, 'Finalització'),
            h('div', { class: 'person' }, avatar(task.completed_by.name), h('span', {}, task.completed_by.name)),
            h('p', { class: 'muted' }, formatDateTime(task.completed_at)))
        : null);
  }

  // Each tab returns { scroll: [...], footer: element|null }. Only the
  // "scroll" part scrolls; the footer (the comment form) stays in place.

  function descriptionTab() {
    const html = task.definition.description_html;
    return {
      scroll: [html ? h('div', { class: 'markdown', html }) : h('p', { class: 'muted' }, 'Aquesta tasca no té descripció.')],
    };
  }

  function commentsTab() {
    const head = (c, text) => h('div', { class: 'head' },
      h('strong', {}, c.author_name),
      text ? h('span', {}, text) : null,
      !text && c.author_role !== 'student' ? h('span', { class: 'tag' }, 'Professorat') : null,
      h('span', { class: 'when' }, formatDateTime(c.created_at)));
    const items = task.comments.map((c) => {
      if (c.type === 'block') return h('li', { class: 'event-block' }, head(c, 'ha bloquejat la tasca'), h('div', { class: 'text' }, c.content));
      if (c.type === 'unblock') return h('li', { class: 'event-unblock' }, head(c, 'ha desbloquejat la tasca'));
      return h('li', {}, head(c), h('div', { class: 'text' }, c.content));
    });

    let form = null;
    if (task.can_contribute) {
      const text = h('textarea', { rows: '2', maxlength: '5000', required: true, placeholder: 'Escriu un comentari…', 'aria-label': 'Comentari nou' });
      const send = h('button', { class: 'btn primary', type: 'submit' }, 'Comenta');
      form = h('form', {
        class: 'comment-form',
        onSubmit: (event) => {
          event.preventDefault();
          run(send, async () => update(await api.post(`/api/group-tasks/${task.id}/comments`, { content: text.value })));
        },
      }, text, send);
    }
    return {
      scroll: [items.length ? h('ul', { class: 'timeline' }, items) : h('p', { class: 'muted' }, 'Encara no hi ha comentaris.')],
      footer: form,
      scrollToEnd: true, // The newest comment is the last one.
    };
  }

  function blocksTab() {
    if (task.block_events.length === 0) return { scroll: [h('p', { class: 'muted' }, "Aquesta tasca no s'ha bloquejat mai.")] };
    return {
      scroll: [h('ul', { class: 'timeline' }, task.block_events.map((e) =>
        h('li', { class: e.unblocked_at ? '' : 'event-block' },
          h('div', { class: 'head' },
            h('strong', {}, e.unblocked_at ? 'Bloqueig resolt' : 'Bloqueig actiu'),
            h('span', { class: 'when' },
              e.unblocked_at ? `Durada: ${formatDuration(e.duration_seconds)}` : `Fa ${formatDuration(secondsSince(e.blocked_at))}`)),
          h('div', { class: 'text' }, e.reason),
          h('div', { class: 'muted' },
            `Bloquejada per ${e.blocked_by_name} · ${formatDateTime(e.blocked_at)}`,
            e.unblocked_at ? ` — desbloquejada per ${e.unblocked_by_name} · ${formatDateTime(e.unblocked_at)}` : ''))))],
    };
  }

  function historyTab() {
    if (task.history.length === 0) return { scroll: [h('p', { class: 'muted' }, 'Encara no hi ha activitat.')] };
    return { scroll: [h('ul', { class: 'timeline' }, [...task.history].reverse().map((e) => historyItem(e)))] };
  }

  function render() {
    dialog.setTitle(task.title);
    const tabs = [
      ['description', 'Descripció', descriptionTab],
      ['comments', `Comentaris (${task.comment_count})`, commentsTab],
      ['blocks', `Bloquejos (${task.block_events.length})`, blocksTab],
      ['history', 'Historial', historyTab],
    ];
    const tab = tabs.find(([key]) => key === activeTab)[2]();
    const scroll = h('div', { class: 'tab-scroll', tabindex: '0' }, tab.scroll);

    append(clear(content),
      h('div', { class: 'detail-meta' },
        h('span', { class: 'muted' }, `${task.project.name} · Grup ${task.group.group_number}`),
        moduleChips(task.modules)),
      h('div', { class: 'detail-layout' },
        h('div', { class: 'detail-main' },
          h('div', { class: 'subtabs', role: 'tablist' }, tabs.map(([key, label]) =>
            h('button', {
              type: 'button', role: 'tab', 'aria-selected': String(key === activeTab),
              onClick: () => { activeTab = key; render(); },
            }, label))),
          h('div', { class: 'tab-panel', role: 'tabpanel' }, scroll, tab.footer || null)),
        sidePanel())
    );
    if (tab.scrollToEnd) scroll.scrollTop = scroll.scrollHeight;
  }

  render();
  return dialog;
}
