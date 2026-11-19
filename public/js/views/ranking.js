// Teamwork badges ("Insígnies"): every group's progress and the badges it has
// earned by working together. There is no ranking: any group can earn every
// badge. Staff see it as a project tab; students on a page of their own, when
// the project shows it to them.
import { api } from '../api.js';
import { append, groupLabel, h, modal } from '../ui.js';

// What each badge is and how a group earns it.
const BADGES = {
  everyone: {
    icon: '🙌', title: 'Tothom treballa',
    how: 'Ningú no ha finalitzat menys tasques de les que li tocarien a parts iguals, amb un marge del 15% i, com a mínim, d\'una tasca. Amb 12 tasques entre 3 persones en toquen 4 a cadascuna, i el mínim és 3. Tothom n\'ha de tenir almenys una.',
    why: 'En un equip ningú no es queda mirant: tothom hi aporta feina acabada.',
  },
  balanced: {
    icon: '⚖️', title: 'Feina ben repartida',
    how: 'Ningú no ha finalitzat més tasques de les que li tocarien a parts iguals, amb un marge del 15% i, com a mínim, d\'una tasca. Amb 12 tasques entre 3 persones en toquen 4 a cadascuna, i el màxim és 5.',
    why: 'La feina no recau sempre en les mateixes persones: es reparteix de manera equitativa.',
  },
  versatile: {
    icon: '🧩', title: 'Polivalents',
    how: 'Cada persona ha finalitzat tasques de, com a mínim, la meitat de les etiquetes que ha treballat el grup.',
    why: 'Tothom s\'atreveix amb tasques de tipus diferents, en lloc de fer sempre el mateix.',
  },
  autonomous: {
    icon: '🧭', title: 'Autonomia',
    how: 'Cada persona ha finalitzat pel seu compte, sense col·laboradors, almenys un terç de les seves tasques.',
    why: 'Cada membre és capaç de tirar endavant una tasca sense dependre dels altres.',
  },
};
const UNAVAILABLE = {
  team: 'Per a grups de dues persones o més',
  tags: 'Cal que el projecte tingui dues etiquetes o més',
};

// A name for how far a group has got, to make the percentage friendlier.
function level(percent) {
  if (percent >= 100) return 'Projecte completat';
  if (percent >= 75) return 'Recta final';
  if (percent >= 50) return 'A bon ritme';
  if (percent >= 25) return 'En marxa';
  if (percent > 0) return 'Arrencant';
  return 'A la línia de sortida';
}

const bar = (percent, label) =>
  h('div', { class: 'rank-bar', role: 'img', 'aria-label': label }, h('span', { class: 'rank-fill', style: { width: `${percent}%` } }));

// What the "?" of a badge opens: how to earn it and where the group stands.
function explain(badge) {
  const info = BADGES[badge.key];
  const standing = badge.unavailable
    ? `Aquest grup no la pot aconseguir: ${UNAVAILABLE[badge.unavailable].toLowerCase()}.`
    : `${badge.earned ? 'Aquest grup la té ara mateix' : 'Aquest grup no la té ara mateix'}. ${badge.progress}.`;
  modal({
    title: `${info.icon} ${info.title}`,
    body: h('div', {},
      h('p', {}, h('strong', {}, "Com s'aconsegueix: "), info.how),
      h('p', { class: 'muted' }, info.why),
      h('p', {}, standing),
      h('p', { class: 'muted' }, "Es calcula sobre totes les tasques finalitzades fins ara, i es torna a calcular cada vegada: una insígnia aconseguida es pot perdre si el grup deixa de treballar així.")),
  });
}

function badgeTile(badge) {
  const info = BADGES[badge.key];
  const state = badge.unavailable ? 'unavailable' : badge.earned ? 'earned' : 'locked';
  const status = badge.unavailable ? UNAVAILABLE[badge.unavailable] : badge.progress;
  return h('li', { class: `badge ${state}` },
    h('span', { class: 'badge-icon', 'aria-hidden': 'true' }, info.icon),
    h('span', { class: 'badge-text' },
      h('strong', {}, info.title, badge.earned ? h('span', { class: 'badge-check', 'aria-label': 'Aconseguida' }, ' ✓') : null),
      h('span', {}, status)),
    h('button', {
      class: 'badge-how', type: 'button', 'aria-label': `Com s'aconsegueix «${info.title}»`, title: "Com s'aconsegueix",
      onClick: () => explain(badge),
    }, '?'));
}

function groupCard(group, data) {
  const label = groupLabel(group.group_number, group.name);
  const available = group.badges.filter((badge) => !badge.unavailable);
  const earned = available.filter((badge) => badge.earned).length;
  return h('li', { class: `rank-row ${group.is_mine ? 'mine' : ''}` },
    h('div', { class: 'rank-head' },
      h('div', { class: 'rank-title' },
        group.id && data.can_manage ? h('a', { href: `#/groups/${group.id}` }, label) : h('span', {}, label),
        group.is_mine ? h('span', { class: 'tag' }, 'El teu grup') : null,
        h('span', { class: 'rank-level' }, level(group.percent))),
      h('div', { class: 'rank-count' }, h('strong', {}, `${earned} de ${available.length}`), ' insígnies')),
    h('div', { class: 'rank-progress' },
      // The vertical mark is the class average, so a group sees where it stands.
      h('div', { class: 'rank-bar-wrap' },
        bar(group.percent, `${label}: ${group.percent}% del projecte completat; la mitjana de la classe és ${data.class_percent}%`),
        h('span', { class: 'rank-average', style: { left: `${data.class_percent}%` }, title: `Mitjana de la classe: ${data.class_percent}%` })),
      h('span', {}, `${group.percent}% · ${group.completed} de ${group.total} ${group.total === 1 ? 'tasca' : 'tasques'}`),
      group.percent > data.class_percent
        ? h('span', { class: 'trend up' }, '▲ Per sobre de la mitjana')
        : group.percent < data.class_percent
          ? h('span', { class: 'trend down' }, '▼ Per sota de la mitjana')
          : h('span', { class: 'trend' }, '● A la mitjana')),
    h('ul', { class: 'badge-list' }, group.badges.map(badgeTile)));
}

// The whole page content for a project, ready to be placed in a page.
export async function rankingContent(projectId) {
  const data = await api.get(`/api/projects/${projectId}/ranking`);
  const el = h('div', { class: 'ranking' });
  if (data.groups.length === 0) {
    return append(el, h('div', { class: 'empty' }, 'Aquest projecte encara no té grups.'));
  }

  return append(el,
    data.can_manage
      ? h('div', { class: 'notice' }, data.project.ranking_visible
          ? "L'alumnat també veu aquesta pàgina, sense els noms de les persones dels altres grups."
          : "Ara només la veu el professorat. Per mostrar-la a l'alumnat, activa «Mostra les insígnies» a «Edita el projecte».")
      : null,
    h('div', { class: 'rank-hero' },
      h('div', { class: 'rank-hero-title' }, h('span', { class: 'rank-trophy', 'aria-hidden': 'true' }, '🤝'),
        h('div', {}, h('h2', {}, 'Insígnies de treball en equip'), h('p', {}, data.project.name))),
      h('div', { class: 'rank-goal' },
        h('div', { class: 'rank-goal-text' },
          h('strong', {}, `${data.class_percent}%`),
          h('span', {}, 'de mitjana: és el que ha completat la classe en conjunt')),
        bar(data.class_percent, `La classe ha completat el ${data.class_percent}% del projecte`),
        h('div', { class: 'rank-goal-badges' }, `${data.badges_earned} de ${data.badges_total} insígnies aconseguides entre tots els grups`))),
    h('ol', { class: 'rank-list' }, data.groups.map((group) => groupCard(group, data))),
    h('p', { class: 'muted rank-legend' },
      h('span', { class: 'rank-average-key', 'aria-hidden': 'true' }),
      `La marca vertical de cada barra és la mitjana de la classe (${data.class_percent}%). `,
      "Treballar en equip no vol dir fer totes les tasques plegats: vol dir que tothom treballa, que la feina es reparteix de manera equitativa i que cada persona sap fer tasques de tipus diferents i tirar-ne endavant una tota sola. Tots els grups poden aconseguir totes les insígnies, i també perdre-les: es calculen sobre tota la feina finalitzada fins ara. El botó «?» de cadascuna explica com. No mesuren la qualitat de la feina, que valora el professorat."));
}

// Page for students, who have no project page of their own.
export async function renderStudentRanking(view, project) {
  append(view,
    h('div', { class: 'page-header' },
      h('div', { class: 'titles' },
        h('div', { class: 'breadcrumb' },
          h('a', { href: '#/' }, 'Els meus projectes'), ' / ',
          h('a', { href: `#/groups/${project.my_group_id}` }, project.name)),
        h('h1', {}, 'Insígnies')),
      h('div', { class: 'actions' }, h('a', { class: 'btn', href: `#/groups/${project.my_group_id}` }, 'Torna al tauler'))),
    await rankingContent(project.id));
}
