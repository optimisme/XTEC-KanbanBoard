// DOM helpers, icons, dialogs and formatting shared by every view.

// Creates an element. `html` must only ever receive server-sanitized HTML.
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'html') el.innerHTML = value;
    else if (key === 'style') {
      for (const [prop, v] of Object.entries(value)) el.style.setProperty(prop, v);
    } else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value') el.value = value;
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  el.append(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

const ICON_PATHS = {
  pending: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
  in_progress: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13v4l3 2',
  blocked: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM5.6 5.6l12.8 12.8',
  completed: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-4-9 3 3 5-6',
  comment: 'M4 5h16v11H9l-5 4V5Z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0',
  up: 'm6 15 6-6 6 6',
  down: 'm6 9 6 6 6-6',
  close: 'M6 6l12 12M18 6 6 18',
  plus: 'M12 5v14M5 12h14',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1',
};

export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICON_PATHS[name]);
  svg.append(path);
  return svg;
}

// ---- Domain vocabulary (Catalan) ------------------------------------------

export const STATUSES = ['pending', 'in_progress', 'blocked', 'completed'];
export const STATUS_LABELS = {
  pending: 'Pendent',
  in_progress: 'En curs',
  blocked: 'Bloquejat',
  completed: 'Finalitzat',
};
export const ROLE_LABELS = { admin: 'Administració', teacher: 'Professorat', student: 'Alumnat' };
export const USER_STATUS_LABELS = {
  pending: "Pendent d'aprovació",
  active: 'Actiu',
  rejected: 'Rebutjat',
  disabled: 'Desactivat',
};
export const EVENT_LABELS = {
  started: 'ha començat la tasca',
  auto_assigned: 'ha quedat com a responsable automàticament',
  responsibility_transferred: 'ha canviat la persona responsable',
  state_changed: "ha canviat l'estat",
  blocked: 'ha bloquejat la tasca',
  unblocked: 'ha desbloquejat la tasca',
  completed: 'ha finalitzat la tasca',
  reopened: 'ha reobert la tasca',
  comment_added: 'ha afegit un comentari',
};

export function statusBadge(status) {
  return h('span', { class: `status ${status}` }, icon(status), STATUS_LABELS[status]);
}

export function tagChip(tag) {
  return h('span', { class: 'chip', title: tag.name, style: { background: tag.color, color: tag.text_color } }, tag.name);
}

export function tagChips(tags) {
  return h('div', { class: 'chips' }, tags.map(tagChip));
}

// Dark or white text, whichever reads better on a background color (the
// server applies the same rule when it stores a tag).
export function readableTextColor(hex) {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#1f2933' : '#ffffff';
}

const NEW_TAG_STYLE = { color: '#e5e7eb', text_color: '#1f2933' };

// Tag editor for a task: the chosen tags, a box to type a new one, and
// clickable suggestions. `suggestions` is { project: [tag], other: [tag] }.
// Returns { el, values() } where values() is the list of tag names.
export function tagPicker(selectedTags, suggestions) {
  const known = [...suggestions.project, ...suggestions.other];
  const styleOf = (name) => known.find((tag) => tag.name.toLowerCase() === name.toLowerCase()) || NEW_TAG_STYLE;
  const selected = selectedTags.map((tag) => tag.name);
  const has = (name) => selected.some((n) => n.toLowerCase() === name.toLowerCase());

  const chosenEl = h('div', { class: 'chips tag-picker-chosen' });
  const suggestedEl = h('div', { class: 'tag-picker-suggestions' });
  const input = plainInput({ maxlength: '40', placeholder: 'Escriu una etiqueta i prem Retorn', 'aria-label': 'Etiqueta nova' });
  const addButton = h('button', { class: 'btn', type: 'button' }, 'Afegeix');

  function add(name) {
    const cleaned = name.trim().replace(/,+$/, '').trim();
    if (!cleaned || has(cleaned)) return;
    // Reuse the existing spelling of a known tag.
    const existing = known.find((tag) => tag.name.toLowerCase() === cleaned.toLowerCase());
    selected.push(existing ? existing.name : cleaned);
    draw();
  }

  function draw() {
    append(clear(chosenEl), selected.length === 0
      ? h('span', { class: 'muted' }, 'Sense etiquetes.')
      : selected.map((name, index) => {
          const style = styleOf(name);
          const remove = h('button', { type: 'button', class: 'chip-remove', 'aria-label': `Treu l'etiqueta ${name}` }, '×');
          remove.addEventListener('click', () => { selected.splice(index, 1); draw(); });
          return h('span', { class: 'chip removable', style: { background: style.color, color: style.text_color } }, name, remove);
        }));

    const offer = (tags) => tags.filter((tag) => !has(tag.name)).map((tag) => {
      const button = h('button', { type: 'button', class: 'chip suggestion', style: { background: tag.color, color: tag.text_color }, title: `Afegeix ${tag.name}` }, `+ ${tag.name}`);
      button.addEventListener('click', () => add(tag.name));
      return button;
    });
    const own = offer(suggestions.project);
    const other = offer(suggestions.other);
    append(clear(suggestedEl),
      own.length ? [h('span', { class: 'muted' }, 'Del projecte:'), own] : null,
      other.length ? [h('span', { class: 'muted' }, "D'altres projectes:"), other] : null);
  }

  const commit = () => { add(input.value); input.value = ''; input.focus(); };
  addButton.addEventListener('click', commit);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); commit(); }
  });

  draw();
  return {
    el: h('div', { class: 'tag-picker' }, chosenEl, h('div', { class: 'inline-form' }, input, addButton), suggestedEl),
    // Text still in the box counts as a tag, so nothing typed is lost on save.
    values: () => { if (input.value.trim()) commit(); return [...selected]; },
  };
}

export function avatar(name) {
  const initials = String(name || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] || '')
    .join('')
    .toUpperCase();
  return h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials);
}

// ---- Formatting --------------------------------------------------------------

const dateTime = new Intl.DateTimeFormat('ca-ES', { dateStyle: 'medium', timeStyle: 'short' });
const dateOnly = new Intl.DateTimeFormat('ca-ES', { dateStyle: 'medium' });

export const formatDateTime = (value) => (value ? dateTime.format(new Date(value)) : '');
export const formatDate = (value) => (value ? dateOnly.format(new Date(value)) : '');

export function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days} d ${hours} h`;
  if (hours > 0) return `${hours} h ${minutes} min`;
  if (minutes > 0) return `${minutes} min`;
  return 'menys d\'1 min';
}

export const secondsSince = (value) => (Date.now() - new Date(value).getTime()) / 1000;

// ---- Feedback ------------------------------------------------------------------

export function toast(message, type = 'info') {
  const el = h('div', { class: `toast ${type === 'error' ? 'error' : ''}` }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 3500);
}

export const showError = (err) => toast(err.message || "S'ha produït un error inesperat.", 'error');

// Runs an async action from a button, disabling it meanwhile and reporting errors.
export async function run(button, action) {
  if (button) button.disabled = true;
  try {
    return await action();
  } catch (err) {
    showError(err);
    return undefined;
  } finally {
    if (button) button.disabled = false;
  }
}

// ---- Modal dialogs ----------------------------------------------------------------

const openModals = [];

export function modal({ title, body, footer, wide = false, fit = false, onClose }) {
  const previousFocus = document.activeElement;
  const titleId = `modal-title-${Date.now()}-${openModals.length}`;
  const closeButton = h('button', { class: 'btn ghost icon-only', type: 'button', 'aria-label': 'Tanca' }, icon('close'));
  const titleEl = h('h2', { id: titleId }, title);
  const bodyEl = h('div', { class: 'modal-body' }, body);
  const footerEl = h('div', { class: 'modal-footer' }, footer || []);
  const dialog = h(
    'div',
    { class: `modal ${wide ? 'wide' : ''} ${fit ? 'fit' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' },
    h('div', { class: 'modal-header' }, titleEl, closeButton),
    bodyEl,
    footer ? footerEl : null
  );
  const overlay = h('div', { class: 'overlay' }, dialog);

  const handle = {
    body: bodyEl,
    footer: footerEl,
    setTitle(text) {
      titleEl.textContent = text;
    },
    close() {
      const index = openModals.indexOf(handle);
      if (index === -1) return;
      openModals.splice(index, 1);
      overlay.remove();
      if (openModals.length === 0) document.body.style.removeProperty('overflow');
      if (previousFocus && previousFocus.focus) previousFocus.focus();
      if (onClose) onClose();
    },
  };

  closeButton.addEventListener('click', handle.close);
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) handle.close();
  });
  document.body.append(overlay);
  document.body.style.setProperty('overflow', 'hidden');
  openModals.push(handle);
  const firstField = dialog.querySelector('input, textarea, select');
  (firstField || dialog).focus();
  return handle;
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && openModals.length > 0) openModals[openModals.length - 1].close();
});

export function closeAllModals() {
  while (openModals.length > 0) openModals[openModals.length - 1].close();
}

export function confirmDialog({ title, message, confirmLabel = 'Confirma', danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    const confirm = h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, type: 'button' }, confirmLabel);
    const cancel = h('button', { class: 'btn', type: 'button' }, 'Cancel·la');
    const dialog = modal({ title, body: h('p', {}, message), footer: [cancel, confirm], onClose: () => resolve(result) });
    cancel.addEventListener('click', dialog.close);
    confirm.addEventListener('click', () => {
      result = true;
      dialog.close();
    });
    confirm.focus();
  });
}

// Asks for a line or a paragraph of text. Resolves to null when cancelled.
export function promptDialog({ title, label, hint, confirmLabel = 'Desa', multiline = false, value = '', required = true }) {
  return new Promise((resolve) => {
    let result = null;
    const input = multiline
      ? h('textarea', { id: 'prompt-input', rows: '4', required })
      : h('input', { id: 'prompt-input', type: 'text', required });
    input.value = value;
    const confirm = h('button', { class: 'btn primary', type: 'submit' }, confirmLabel);
    const cancel = h('button', { class: 'btn', type: 'button' }, 'Cancel·la');
    const form = h(
      'form',
      {
        onSubmit: (event) => {
          event.preventDefault();
          const text = input.value.trim();
          if (required && !text) return input.focus();
          result = text;
          dialog.close();
        },
      },
      h('div', { class: 'field' }, h('label', { for: 'prompt-input' }, label), input, hint ? h('div', { class: 'hint' }, hint) : null),
      h('div', { class: 'card-actions' }, confirm, cancel)
    );
    const dialog = modal({ title, body: form, onClose: () => resolve(result) });
    cancel.addEventListener('click', dialog.close);
  });
}

// ---- Small form helpers --------------------------------------------------------------

export function field(label, control, hint) {
  const id = control.id || `f-${Math.random().toString(36).slice(2, 9)}`;
  control.id = id;
  return h('div', { class: 'field' }, h('label', { for: id }, label), control, hint ? h('div', { class: 'hint' }, hint) : null);
}

// An on/off switch with its label. `onChange(checked)` runs on every change.
export function toggleSwitch(label, checked, onChange) {
  const input = h('input', { type: 'checkbox', role: 'switch' });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'switch' }, input, h('span', { class: 'switch-track', 'aria-hidden': 'true' }), h('span', {}, label));
}

// A text box for searching or typing something the browser should not try to
// fill in by itself. Browsers treat autocomplete="off" as a hint, so several
// signals are combined: a search field, a name that is different every time
// (remembered entries are stored by field name), and the markers the common
// password managers look for.
export function plainInput(attrs = {}) {
  return h('input', {
    type: 'search',
    name: `q-${Math.random().toString(36).slice(2, 10)}`,
    autocomplete: 'off',
    autocorrect: 'off',
    autocapitalize: 'none',
    spellcheck: 'false',
    'data-1p-ignore': 'true',
    'data-lpignore': 'true',
    'data-bwignore': 'true',
    'data-form-type': 'other',
    ...attrs,
  });
}

// Appends children like h() does: nested arrays are flattened and empty
// values (null, undefined, false) are skipped.
export function append(el, ...children) {
  el.append(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}
