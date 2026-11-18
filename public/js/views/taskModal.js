// Group task detail dialog: definition, state changes, responsibility,
// comments, evidence, blocking events and activity history.
import { api } from '../api.js';
import {
  append, avatar, clear, EVENT_LABELS, field, formatBytes, formatDateTime, formatDuration, h, icon, modal,
  moduleChips, promptDialog, run, secondsSince, STATUS_LABELS, statusBadge, toast,
} from '../ui.js';
import { openTaskEditor, openVersions } from './taskEditor.js';

const ACTION_LABELS = {
  'pending>in_progress': 'Comença la tasca',
  'in_progress>completed': 'Marca com a finalitzada',
  'in_progress>blocked': 'Bloqueja la tasca',
  'blocked>in_progress': 'Desbloqueja la tasca',
  'completed>in_progress': 'Reobre la tasca',
  'in_progress>pending': 'Torna-la a pendent',
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

function historyDetail(event) {
  if (event.event_type === 'responsibility_transferred' || event.event_type === 'auto_assigned') {
    const from = event.old_user_name || (event.old_value ? 'usuari eliminat' : 'ningú');
    const to = event.new_user_name || (event.new_value ? 'usuari eliminat' : 'ningú');
    return event.event_type === 'auto_assigned' ? `Responsable: ${to}` : `${from} → ${to}`;
  }
  if (STATUS_LABELS[event.old_value] && STATUS_LABELS[event.new_value]) {
    return `${STATUS_LABELS[event.old_value]} → ${STATUS_LABELS[event.new_value]}`;
  }
  return '';
}

export function historyItem(event, { withTask = false } = {}) {
  const detail = historyDetail(event);
  return h('li', {},
    h('div', { class: 'head' },
      h('strong', {}, event.actor_name),
      h('span', {}, EVENT_LABELS[event.event_type] || event.event_type),
      h('span', { class: 'when' }, formatDateTime(event.created_at))),
    detail || withTask
      ? h('div', { class: 'muted' }, [withTask ? `${event.title} · Grup ${event.group_number}` : null, detail].filter(Boolean).join(' · '))
      : null);
}

export async function openTaskModal(groupTaskId, { onChange = () => {} } = {}) {
  let task = await api.get(`/api/group-tasks/${groupTaskId}`);
  let activeTab = 'comments';
  const content = h('div', {});
  const dialog = modal({ title: task.title, body: content, wide: true });

  const update = (updated) => {
    if (!updated) return;
    task = updated;
    render();
    onChange(task);
  };
  const reload = async () => update(await api.get(`/api/group-tasks/${groupTaskId}`));

  function sidePanel() {
    const stateButtons = task.allowed_transitions.map((target) => {
      const label = ACTION_LABELS[`${task.status}>${target}`] || `Mou a «${STATUS_LABELS[target]}»`;
      const primary = ['pending>in_progress', 'in_progress>completed', 'blocked>in_progress'].includes(`${task.status}>${target}`);
      const button = h('button', { class: `btn ${primary ? 'primary' : ''}`, type: 'button' }, label);
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
        h('div', { class: 'stack' }, stateButtons),
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
            h('p', { class: 'muted' }, `${formatDateTime(task.completed_at)} · versió ${task.completed_version} de la definició`))
        : null,
      h('section', {},
        h('h3', {}, 'Definició'),
        h('p', { class: 'muted' }, `Versió ${task.definition.version} · ${formatDateTime(task.definition.updated_at)}`),
        task.can_manage
          ? h('div', { class: 'stack' },
              task.can_contribute
                ? h('button', {
                    class: 'btn', type: 'button',
                    onClick: () => openTaskEditor({ projectId: task.project.id, taskId: task.task_id, onSaved: reload }),
                  }, 'Edita la definició')
                : null,
              h('button', { class: 'btn', type: 'button', onClick: () => openVersions(task.task_id) }, 'Historial de versions'))
          : null));
  }

  function commentsTab() {
    const items = task.comments.map((c) => {
      if (c.type === 'block') {
        return h('li', { class: 'event-block' },
          h('div', { class: 'head' }, h('strong', {}, c.author_name), h('span', {}, 'ha bloquejat la tasca'), h('span', { class: 'when' }, formatDateTime(c.created_at))),
          h('div', { class: 'text' }, c.content));
      }
      if (c.type === 'unblock') {
        return h('li', { class: 'event-unblock' },
          h('div', { class: 'head' }, h('strong', {}, c.author_name), h('span', {}, 'ha desbloquejat la tasca'), h('span', { class: 'when' }, formatDateTime(c.created_at))));
      }
      return h('li', {},
        h('div', { class: 'head' },
          h('strong', {}, c.author_name),
          c.author_role !== 'student' ? h('span', { class: 'tag' }, 'Professorat') : null,
          h('span', { class: 'when' }, formatDateTime(c.created_at))),
        h('div', { class: 'text' }, c.content));
    });

    let form = null;
    if (task.can_contribute) {
      const text = h('textarea', { rows: '3', maxlength: '5000', required: true, placeholder: 'Escriu un comentari…', 'aria-label': 'Comentari nou' });
      const send = h('button', { class: 'btn primary', type: 'submit' }, 'Comenta');
      form = h('form', {
        onSubmit: (event) => {
          event.preventDefault();
          run(send, async () => update(await api.post(`/api/group-tasks/${task.id}/comments`, { content: text.value })));
        },
      }, h('div', { class: 'field' }, text), send);
    }
    return [
      items.length ? h('ul', { class: 'timeline' }, items) : h('p', { class: 'muted' }, 'Encara no hi ha comentaris.'),
      form,
    ];
  }

  function evidenceTab() {
    const kinds = { link: 'Enllaç', github_commit: 'Commit de GitHub', github_pull_request: 'Pull request de GitHub', file: 'Fitxer' };
    const items = task.attachments.map((a) =>
      h('li', {},
        h('div', { class: 'evidence' },
          a.is_image ? h('img', { src: a.download_url, alt: '' }) : null,
          h('div', { class: 'info' },
            h('a', { href: a.kind === 'file' ? a.download_url : a.url, target: '_blank', rel: 'noopener noreferrer' }, a.title),
            h('div', { class: 'head' },
              h('span', { class: 'tag' }, kinds[a.kind]),
              a.size_bytes ? h('span', { class: 'when' }, formatBytes(a.size_bytes)) : null,
              h('span', { class: 'when' }, `${a.author.name} · ${formatDateTime(a.created_at)}`))))));

    let forms = null;
    if (task.can_contribute) {
      const file = h('input', { type: 'file', required: true, 'aria-label': 'Fitxer' });
      const upload = h('button', { class: 'btn', type: 'submit' }, 'Puja el fitxer');
      const url = h('input', { type: 'url', required: true, placeholder: 'https://github.com/…' });
      const title = h('input', { type: 'text', maxlength: '255', placeholder: 'Títol (opcional)' });
      const add = h('button', { class: 'btn', type: 'submit' }, "Afegeix l'enllaç");
      forms = h('div', { class: 'box' },
        h('form', {
          class: 'field',
          onSubmit: (event) => {
            event.preventDefault();
            run(upload, async () => {
              const data = new FormData();
              data.append('file', file.files[0]);
              update(await api.post(`/api/group-tasks/${task.id}/attachments`, data));
            });
          },
        },
          h('label', {}, 'Puja una imatge o un document'),
          h('div', { class: 'inline-form' }, file, upload),
          h('div', { class: 'hint' }, 'Imatges, PDF, text, ZIP i documents d\'ofimàtica.')),
        h('form', {
          onSubmit: (event) => {
            event.preventDefault();
            run(add, async () => update(await api.post(`/api/group-tasks/${task.id}/attachments`, { url: url.value, title: title.value })));
          },
        },
          h('label', {}, 'Afegeix un enllaç, un commit o una pull request'),
          h('div', { class: 'form-row' }, url, title),
          h('div', { class: 'card-actions' }, add)));
    }
    return [
      items.length ? h('ul', { class: 'timeline' }, items) : h('p', { class: 'muted' }, 'Encara no hi ha evidències.'),
      forms,
    ];
  }

  function blocksTab() {
    if (task.block_events.length === 0) return [h('p', { class: 'muted' }, "Aquesta tasca no s'ha bloquejat mai.")];
    return [
      h('ul', { class: 'timeline' }, task.block_events.map((e) =>
        h('li', { class: e.unblocked_at ? '' : 'event-block' },
          h('div', { class: 'head' },
            h('strong', {}, e.unblocked_at ? 'Bloqueig resolt' : 'Bloqueig actiu'),
            h('span', { class: 'when' },
              e.unblocked_at ? `Durada: ${formatDuration(e.duration_seconds)}` : `Fa ${formatDuration(secondsSince(e.blocked_at))}`)),
          h('div', { class: 'text' }, e.reason),
          h('div', { class: 'muted' },
            `Bloquejada per ${e.blocked_by_name} · ${formatDateTime(e.blocked_at)}`,
            e.unblocked_at ? ` — desbloquejada per ${e.unblocked_by_name} · ${formatDateTime(e.unblocked_at)}` : '')))),
    ];
  }

  function historyTab() {
    if (task.history.length === 0) return [h('p', { class: 'muted' }, 'Encara no hi ha activitat.')];
    return [h('ul', { class: 'timeline' }, [...task.history].reverse().map((e) => historyItem(e)))];
  }

  function render() {
    dialog.setTitle(task.title);
    const tabs = [
      ['comments', `Comentaris (${task.comment_count})`, commentsTab],
      ['evidence', `Evidències (${task.attachment_count})`, evidenceTab],
      ['blocks', `Bloquejos (${task.block_events.length})`, blocksTab],
      ['history', 'Historial', historyTab],
    ];
    const panel = h('div', { role: 'tabpanel' }, tabs.find(([key]) => key === activeTab)[2]());
    append(clear(content), 
      h('div', { class: 'detail-meta' },
        h('span', { class: 'muted' }, `${task.project.name} · Grup ${task.group.group_number}`),
        moduleChips(task.modules)),
      h('div', { class: 'detail-grid' },
        h('div', {},
          h('h3', { class: 'section-title' }, 'Descripció'),
          task.definition.description_html
            ? h('div', { class: 'box markdown', html: task.definition.description_html })
            : h('p', { class: 'muted' }, 'Sense descripció.'),
          h('h3', { class: 'section-title' }, "Criteris d'acceptació"),
          task.definition.acceptance_criteria_html
            ? h('div', { class: 'box markdown', html: task.definition.acceptance_criteria_html })
            : h('p', { class: 'muted' }, "Sense criteris d'acceptació."),
          h('div', { class: 'subtabs', role: 'tablist' }, tabs.map(([key, label]) =>
            h('button', {
              type: 'button', role: 'tab', 'aria-selected': String(key === activeTab),
              onClick: () => { activeTab = key; render(); },
            }, label))),
          panel),
        sidePanel())
    );
  }

  render();
  return dialog;
}
