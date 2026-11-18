// Application shell: session bootstrap, navigation and hash-based routing.
import { api, ApiError, loadSession, setCsrfToken } from './api.js';
import { append, clear, closeAllModals, field, h, ROLE_LABELS, run, showError } from './ui.js';
import { renderModules, renderUsers } from './views/admin.js';
import { renderBoard } from './views/board.js';
import { renderProject } from './views/project.js';
import { renderProjects } from './views/projects.js';
import { renderBlocked, renderContributions } from './views/supervision.js';

const root = document.getElementById('app');
const state = { session: null };

const routes = [
  { pattern: /^\/?$/, render: renderProjects, nav: 'projects' },
  { pattern: /^\/projects\/(\d+)\/students\/(\d+)$/, render: renderContributions, nav: 'projects' },
  { pattern: /^\/projects\/(\d+)(?:\/(\w+))?$/, render: renderProject, nav: 'projects' },
  { pattern: /^\/groups\/(\d+)(?:\/task\/(\d+))?$/, render: renderBoard, nav: 'projects', wide: true },
  { pattern: /^\/blocked$/, render: renderBlocked, nav: 'blocked', roles: ['admin', 'teacher'] },
  { pattern: /^\/admin\/users$/, render: renderUsers, nav: 'users', roles: ['admin'] },
  { pattern: /^\/admin\/modules$/, render: renderModules, nav: 'modules', roles: ['admin'] },
  { pattern: /^\/profile$/, render: renderProfile, nav: 'profile' },
];

const LOGIN_ERRORS = {
  domain_not_allowed: 'Només es permeten comptes del domini institucional.',
  email_not_verified: "El proveïdor d'identitat no ha verificat el teu correu.",
  identity_conflict: 'Aquest correu ja està associat a una altra identitat.',
  oidc_not_configured: "L'accés amb el compte institucional encara no està disponible.",
  login_expired: "La sessió d'inici ha caducat. Torna-ho a provar.",
  login_failed: "No s'ha pogut iniciar la sessió. Torna-ho a provar.",
};

function currentPath() {
  return window.location.hash.replace(/^#/, '').split('?')[0] || '/';
}

async function logout() {
  await api.post('/auth/logout').catch(() => {});
  window.location.hash = '';
  window.location.reload();
}

// ---- Screens shown outside the application ------------------------------------

// A centered card. `below` is optional content shown under the card.
function centerScreen(children, below = null) {
  append(clear(root),
    h('main', { class: 'center-screen', id: 'main' },
      h('div', { class: 'center-column' },
        h('div', { class: 'card center-card' }, h('img', { src: '/assets/favicon.svg', alt: '' }), children),
        below))
  );
}

function renderLogin() {
  const params = new URLSearchParams(window.location.hash.split('?')[1] || '');
  const error = LOGIN_ERRORS[params.get('error')];
  const { dev_auth: devAuth } = state.session;

  // One form for everyone who does not come through the identity provider:
  // the administrator from .env (username + password) and, in development
  // only, institutional emails (no password).
  const adminLogin = state.session.admin_login;
  let form = null;
  if (adminLogin || devAuth) {
    const identifier = h('input', {
      type: 'text', required: true, autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false',
      placeholder: devAuth ? 'nom@domini.cat' : null,
    });
    const password = h('input', { type: 'password', autocomplete: 'current-password', required: adminLogin && !devAuth });
    const submit = h('button', { class: 'btn', type: 'submit' }, 'Entra');
    const label = adminLogin && devAuth ? 'Usuari o correu institucional' : adminLogin ? 'Usuari' : 'Correu institucional';

    form = h(
      'form',
      {
        class: 'dev-login',
        onSubmit: (event) => {
          event.preventDefault();
          run(submit, async () => {
            const value = identifier.value.trim();
            // Emails are development accounts; anything else is the administrator.
            const result = devAuth && (value.includes('@') || !adminLogin)
              ? await api.post('/auth/dev-login', { email: value })
              : await api.post('/auth/admin-login', { username: value, password: password.value });
            setCsrfToken(result.csrf_token);
            window.location.hash = '';
            await start();
          });
        },
      },
      field(label, identifier),
      adminLogin
        ? field('Contrasenya', password, devAuth ? "Només cal per al compte d'administració." : null)
        : null,
      submit,
      devAuth
        ? h('p', { class: 'muted', style: { 'margin-top': '12px' } },
            'Mode de desenvolupament: els correus institucionals entren sense contrasenya. No està disponible en producció.')
        : null
    );
  }

  // Institutional sign-in, under the card. Before the identity provider is
  // configured the server sends the visitor back here with a short message.
  const providerName = state.session.oidc_provider === 'microsoft' ? 'Microsoft' : 'Google';
  const oauth = h('div', { class: 'oauth-login' },
    h('a', { class: 'btn primary', href: '/auth/login' }, `Entra amb ${providerName}`));

  centerScreen([
    h('h1', {}, 'Kanban educatiu'),
    error ? h('div', { class: 'notice error', role: 'alert' }, error) : null,
    form,
  ], oauth);
}

function renderAccountState(user) {
  const messages = {
    pending: [
      "Pendent d'aprovació",
      "El teu compte s'ha creat correctament. Una persona administradora l'ha d'aprovar abans que puguis accedir a l'aplicació.",
    ],
    rejected: ['Accés no autoritzat', "La sol·licitud d'accés d'aquest compte ha estat rebutjada."],
    disabled: ['Accés no autoritzat', 'Aquest compte està desactivat. Contacta amb administració si creus que és un error.'],
  };
  const [title, text] = messages[user.status];
  centerScreen([
    h('h1', {}, title),
    h('p', {}, text),
    h('p', { class: 'muted' }, user.email),
    user.status === 'pending' ? h('button', { class: 'btn', type: 'button', onClick: () => window.location.reload() }, 'Torna-ho a comprovar') : null,
    h('button', { class: 'btn ghost', type: 'button', onClick: logout }, 'Tanca la sessió'),
  ]);
}

// ---- Shell -------------------------------------------------------------------------

function renderShell(route) {
  const { user } = state.session;
  const link = (href, label, key) =>
    h('a', { href: `#${href}`, 'aria-current': route && route.nav === key ? 'page' : null }, label);

  const nav = [link('/', user.role === 'student' ? 'Els meus projectes' : 'Projectes', 'projects')];
  if (user.role !== 'student') nav.push(link('/blocked', 'Tasques bloquejades', 'blocked'));
  if (user.role === 'admin') nav.push(link('/admin/users', 'Usuaris', 'users'), link('/admin/modules', 'Mòduls', 'modules'));

  const main = h('main', { class: `main ${route && route.wide ? 'wide' : ''}`, id: 'main', tabindex: '-1' });
  append(clear(root), 
    h('header', { class: 'topbar' },
      h('a', { class: 'brand', href: '#/' }, h('img', { src: '/assets/favicon.svg', alt: '' }), 'Kanban educatiu'),
      h('nav', { class: 'nav', 'aria-label': 'Navegació principal' }, nav),
      h('div', { class: 'userbox' },
        h('a', { href: '#/profile', title: 'El meu perfil' }, user.name),
        h('span', { class: 'tag' }, ROLE_LABELS[user.role]),
        h('button', { class: 'btn small', type: 'button', onClick: logout }, 'Surt'))),
    main
  );
  return main;
}

function renderUnauthorized(main) {
  append(clear(main), 
    h('div', { class: 'empty' },
      h('h1', {}, 'Accés no autoritzat'),
      h('p', {}, 'No tens permís per veure aquesta pàgina.'),
      h('a', { class: 'btn', href: '#/' }, 'Torna a l\'inici'))
  );
}

let renderToken = 0;

async function renderRoute() {
  const { user } = state.session;
  if (!user) return renderLogin();
  if (user.status !== 'active') return renderAccountState(user);

  closeAllModals();
  const path = currentPath();
  let match = null;
  const route = routes.find((r) => (match = path.match(r.pattern)));
  const main = renderShell(route);
  const token = ++renderToken;

  if (!route) {
    append(clear(main), h('div', { class: 'empty' }, h('h1', {}, "No s'ha trobat la pàgina"), h('a', { class: 'btn', href: '#/' }, "Torna a l'inici")));
    return undefined;
  }
  if (route.roles && !route.roles.includes(user.role)) return renderUnauthorized(main);

  append(main, h('p', { class: 'loading' }, "S'està carregant…"));
  try {
    const view = h('div', {});
    await route.render(view, match.slice(1), { user, rerender: renderRoute });
    if (token !== renderToken) return undefined; // A newer navigation won.
    append(clear(main), view);
  } catch (err) {
    if (token !== renderToken) return undefined;
    if (err instanceof ApiError && err.status === 403) renderUnauthorized(main);
    else {
      append(clear(main), h('div', { class: 'notice error', role: 'alert' }, err.message));
      if (!(err instanceof ApiError)) console.error(err);
    }
  }
  return undefined;
}

// ---- Profile ------------------------------------------------------------------------

async function renderProfile(view, params, { user }) {
  const name = h('input', { type: 'text', value: user.name, maxlength: '200', required: true });
  const save = h('button', { class: 'btn primary', type: 'submit' }, 'Desa');
  append(view, 
    h('div', { class: 'page-header' }, h('h1', {}, 'El meu perfil')),
    h('form',
      {
        class: 'card',
        style: { 'max-width': '520px' },
        onSubmit: (event) => {
          event.preventDefault();
          run(save, async () => {
            await api.patch('/api/profile', { name: name.value });
            await start();
          });
        },
      },
      field('Nom', name),
      h('div', { class: 'field' }, h('label', {}, 'Correu'), h('div', {}, user.email)),
      h('div', { class: 'field' }, h('label', {}, 'Rol'), h('div', {}, ROLE_LABELS[user.role])),
      save)
  );
}

// ---- Bootstrap -----------------------------------------------------------------------

async function start() {
  try {
    state.session = await loadSession();
    await renderRoute();
  } catch (err) {
    append(clear(root), h('p', { class: 'loading' }, "No s'ha pogut carregar l'aplicació."));
    showError(err);
  }
}

window.addEventListener('hashchange', () => {
  if (state.session) renderRoute();
});
start();
