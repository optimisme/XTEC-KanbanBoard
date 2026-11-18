// Administrator screens: user management (with pending approvals) and
// professional modules.
import { api } from '../api.js';
import {
  append, clear, confirmDialog, field, formatDate, h, modal, moduleChip, ROLE_LABELS, run, showError, toast,
  USER_STATUS_LABELS,
} from '../ui.js';

const roleSelect = (value, label) => {
  const select = h('select', { 'aria-label': label }, Object.entries(ROLE_LABELS).map(([key, text]) => h('option', { value: key }, text)));
  select.value = value;
  return select;
};

export async function renderUsers(view, params, { user: me }) {
  const pendingEl = h('div', {});
  const tableEl = h('div', {});
  const statusFilter = h('select', { id: 'user-status' },
    h('option', { value: '' }, 'Tots els estats'),
    Object.entries(USER_STATUS_LABELS).map(([key, text]) => h('option', { value: key }, text)));
  const roleFilter = h('select', { id: 'user-role' },
    h('option', { value: '' }, 'Tots els rols'),
    Object.entries(ROLE_LABELS).map(([key, text]) => h('option', { value: key }, text)));
  const search = h('input', { type: 'search', id: 'user-search', placeholder: 'Nom o correu' });
  let users = [];

  async function load() {
    users = await api.get('/api/users');
    draw();
  }
  const act = (button, action) => run(button, async () => { await action(); await load(); });

  function draw() {
    const pending = users.filter((u) => u.status === 'pending');
    append(clear(pendingEl), 
      h('div', { class: 'card', style: { 'margin-bottom': '20px' } },
        h('h2', {}, `Pendents d'aprovació (${pending.length})`),
        pending.length === 0
          ? h('p', { class: 'muted' }, "No hi ha cap compte pendent d'aprovació.")
          : h('div', { class: 'table-wrap' }, h('table', {},
              h('thead', {}, h('tr', {}, h('th', {}, 'Nom'), h('th', {}, 'Correu'), h('th', {}, 'Sol·licitud'), h('th', {}, 'Rol'), h('th', {}, ''))),
              h('tbody', {}, pending.map((u) => {
                const role = roleSelect('student', `Rol per a ${u.name}`);
                const approve = h('button', { class: 'btn small primary', type: 'button' }, 'Aprova');
                const reject = h('button', { class: 'btn small danger', type: 'button' }, 'Rebutja');
                approve.addEventListener('click', () => act(approve, async () => {
                  await api.post(`/api/users/${u.id}/approve`, { role: role.value });
                  toast(`${u.name} ja pot accedir a l'aplicació.`);
                }));
                reject.addEventListener('click', () => act(reject, () => api.post(`/api/users/${u.id}/reject`)));
                return h('tr', {},
                  h('td', {}, u.name), h('td', { class: 'muted' }, u.email), h('td', { class: 'muted' }, formatDate(u.created_at)),
                  h('td', {}, role), h('td', { class: 'actions' }, approve, reject));
              })))))
    );

    const term = search.value.trim().toLowerCase();
    const rows = users.filter((u) =>
      u.status !== 'pending' &&
      (!statusFilter.value || u.status === statusFilter.value) &&
      (!roleFilter.value || u.role === roleFilter.value) &&
      (!term || u.name.toLowerCase().includes(term) || u.email.toLowerCase().includes(term)));

    append(clear(tableEl), rows.length === 0
      ? h('div', { class: 'empty' }, 'No hi ha usuaris que coincideixin amb el filtre.')
      : h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Nom'), h('th', {}, 'Correu'), h('th', {}, 'Rol'), h('th', {}, 'Estat'), h('th', {}, 'Darrer accés'), h('th', {}, ''))),
          h('tbody', {}, rows.map((u) => {
            const self = u.id === me.id;
            const role = roleSelect(u.role, `Rol de ${u.name}`);
            role.disabled = self;
            role.addEventListener('change', () => act(role, () => api.patch(`/api/users/${u.id}`, { role: role.value })));
            const next = u.status === 'active' ? 'disabled' : 'active';
            const toggle = h('button', { class: `btn small ${u.status === 'active' ? 'danger' : ''}`, type: 'button', disabled: self },
              u.status === 'active' ? 'Desactiva' : 'Activa');
            toggle.addEventListener('click', () => act(toggle, () => api.patch(`/api/users/${u.id}`, { status: next })));
            return h('tr', {},
              h('td', {}, u.name, self ? h('span', { class: 'tag', style: { 'margin-left': '8px' } }, 'Tu') : null),
              h('td', { class: 'muted' }, u.email),
              h('td', {}, role),
              h('td', {}, h('span', { class: 'tag' }, USER_STATUS_LABELS[u.status])),
              h('td', { class: 'muted' }, u.last_login_at ? formatDate(u.last_login_at) : 'Encara no ha entrat'),
              h('td', { class: 'actions' }, toggle));
          })))));
  }

  // Adds a person by email. They can sign in with the institutional account
  // straight away, without waiting for approval.
  function openAddUser() {
    const name = h('input', { type: 'text', maxlength: '200', required: true, autocomplete: 'off' });
    const email = h('input', { type: 'email', maxlength: '255', required: true, placeholder: 'nom@xtec.cat', autocomplete: 'off' });
    const role = roleSelect('teacher', 'Rol');
    const save = h('button', { class: 'btn primary', type: 'submit' }, "Afegeix l'usuari");
    const form = h('form', {
      onSubmit: (event) => {
        event.preventDefault();
        run(save, async () => {
          const created = await api.post('/api/users', { name: name.value, email: email.value, role: role.value });
          dialog.close();
          toast(`${created.name} ja pot entrar amb el compte institucional.`);
          await load();
        });
      },
    },
      field('Nom i cognoms', name),
      field('Correu institucional', email, 'Ha de coincidir amb el correu del compte amb què iniciarà la sessió.'),
      field('Rol', role),
      h('div', { class: 'card-actions' }, save));
    const dialog = modal({ title: 'Afegeix un usuari', body: form });
  }

  [statusFilter, roleFilter].forEach((el) => el.addEventListener('change', draw));
  search.addEventListener('input', draw);

  append(view, 
    h('div', { class: 'page-header' },
      h('div', { class: 'titles' },
        h('h1', {}, 'Usuaris'),
        h('p', { class: 'muted' }, "Afegeix persones pel seu correu perquè entrin directament, o aprova els comptes nous que queden pendents.")),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'button', onClick: openAddUser }, 'Afegeix un usuari'))),
    pendingEl,
    h('div', { class: 'toolbar' },
      h('label', { for: 'user-search', class: 'sr-only' }, 'Cerca'), search,
      h('label', { for: 'user-status', class: 'sr-only' }, 'Estat'), statusFilter,
      h('label', { for: 'user-role', class: 'sr-only' }, 'Rol'), roleFilter),
    tableEl
  );
  search.style.setProperty('max-width', '260px');
  await load();
}

export async function renderModules(view) {
  const holder = h('div', {});
  let modules = [];

  async function load() {
    modules = await api.get('/api/modules');
    draw();
  }

  function openForm(module) {
    const name = h('input', { type: 'text', maxlength: '120', required: true, value: module ? module.name : '' });
    const color = h('input', { type: 'color', value: module ? module.color : '#2563eb' });
    const preview = h('div', {});
    // Dark or white text, whichever reads better on the chosen color (the
    // server applies the same rule when saving).
    const textFor = (hex) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#1f2933' : '#ffffff';
    };
    const drawPreview = () => append(clear(preview), 
      moduleChip({ name: name.value || 'Nom del mòdul', color: color.value, text_color: textFor(color.value) }));
    name.addEventListener('input', drawPreview);
    color.addEventListener('input', drawPreview);
    drawPreview();

    const save = h('button', { class: 'btn primary', type: 'submit' }, module ? 'Desa' : 'Crea el mòdul');
    const form = h('form', {
      onSubmit: (event) => {
        event.preventDefault();
        run(save, async () => {
          const body = { name: name.value, color: color.value };
          if (module) await api.put(`/api/modules/${module.id}`, body);
          else await api.post('/api/modules', body);
          dialog.close();
          await load();
        });
      },
    },
      field('Nom', name),
      field('Color', color, 'El color del text es tria automàticament perquè sigui llegible.'),
      h('div', { class: 'field' }, h('label', {}, 'Previsualització'), preview),
      h('div', { class: 'card-actions' }, save));
    const dialog = modal({ title: module ? 'Edita el mòdul' : 'Nou mòdul', body: form });
  }

  function draw() {
    append(clear(holder), modules.length === 0
      ? h('div', { class: 'empty' }, 'Encara no hi ha mòduls professionals.')
      : h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Mòdul'), h('th', {}, 'Etiqueta'), h('th', {}, 'Color'), h('th', {}, ''))),
          h('tbody', {}, modules.map((m) => {
            const remove = h('button', { class: 'btn small danger', type: 'button' }, 'Elimina');
            remove.addEventListener('click', async () => {
              const ok = await confirmDialog({
                title: 'Elimina el mòdul', message: `Vols eliminar «${m.name}»? Només és possible si cap projecte l'utilitza.`,
                confirmLabel: 'Elimina', danger: true,
              });
              if (ok) await run(remove, async () => { await api.del(`/api/modules/${m.id}`); await load(); });
            });
            return h('tr', {},
              h('td', {}, m.name),
              h('td', {}, moduleChip(m)),
              h('td', { class: 'muted' }, m.color),
              h('td', { class: 'actions' },
                h('button', { class: 'btn small', type: 'button', onClick: () => openForm(m) }, 'Edita'), remove));
          })))));
  }

  append(view, 
    h('div', { class: 'page-header' },
      h('div', { class: 'titles' },
        h('h1', {}, 'Mòduls professionals'),
        h('p', { class: 'muted' }, 'Els mòduls classifiquen i acoloreixen les tasques. No determinen els permisos del professorat.')),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'button', onClick: () => openForm(null) }, 'Nou mòdul'))),
    holder
  );
  await load().catch(showError);
}
