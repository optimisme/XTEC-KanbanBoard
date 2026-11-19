// Ranking of a project's groups ("Classificació"): a podium, every group's
// progress and the class average. Staff see it as a project tab; students on
// a page of their own, when the project shows it to them.
import { api } from '../api.js';
import { append, groupLabel, h } from '../ui.js';

const MEDALS = { 1: '🥇', 2: '🥈', 3: '🥉' };

// A name for how far a group has got, to make the percentage friendlier.
function level(percent) {
  if (percent >= 100) return 'Projecte completat';
  if (percent >= 75) return 'Recta final';
  if (percent >= 50) return 'A bon ritme';
  if (percent >= 25) return 'En marxa';
  if (percent > 0) return 'Arrencant';
  return 'A la línia de sortida';
}

const tasksText = (group) => `${group.completed} de ${group.total} ${group.total === 1 ? 'tasca' : 'tasques'}`;

// Medals are earned: a group without any finished task has none.
const medal = (group) => (group.completed > 0 ? MEDALS[group.position] : null);

function podium(groups) {
  const top = groups.filter((group) => medal(group)).slice(0, 3);
  if (top.length === 0) return null;
  // Second place on the left, first in the middle, third on the right.
  const order = [top[1], top[0], top[2]].filter(Boolean);
  return h('div', { class: 'podium', role: 'img', 'aria-label': `Podi: ${top.map((g) => `${g.position}. ${groupLabel(g.group_number, g.name)}`).join(', ')}` },
    order.map((group) => h('div', { class: `podium-place place-${group.position} ${group.is_mine ? 'mine' : ''}` },
      h('div', { class: 'podium-medal' }, medal(group)),
      h('div', { class: 'podium-name' }, groupLabel(group.group_number, group.name)),
      h('div', { class: 'podium-step' },
        h('strong', {}, `${group.percent}%`),
        h('span', {}, tasksText(group))))));
}

function row(group, data) {
  const label = groupLabel(group.group_number, group.name);
  const difference = group.percent - data.average_percent;
  const trend = difference > 0
    ? h('span', { class: 'trend up' }, `▲ ${difference} punts per sobre de la mitjana`)
    : difference < 0
      ? h('span', { class: 'trend down' }, `▼ ${-difference} punts per sota de la mitjana`)
      : h('span', { class: 'trend' }, '● A la mitjana');

  return h('li', { class: `rank-row ${group.is_mine ? 'mine' : ''} ${medal(group) ? `place-${group.position}` : ''}` },
    h('div', { class: 'rank-position', 'aria-label': `Posició ${group.position}` }, medal(group) || String(group.position)),
    h('div', { class: 'rank-main' },
      h('div', { class: 'rank-title' },
        group.id && data.can_manage ? h('a', { href: `#/groups/${group.id}` }, label) : h('span', {}, label),
        group.is_mine ? h('span', { class: 'tag' }, 'El teu grup') : null,
        h('span', { class: 'rank-level' }, level(group.percent))),
      h('div', { class: 'rank-bar', role: 'img', 'aria-label': `${label}: ${group.percent}% completat` },
        h('span', { class: 'rank-fill', style: { width: `${group.percent}%` } }),
        h('span', { class: 'rank-average', style: { left: `${data.average_percent}%` }, title: `Mitjana: ${data.average_percent}%` })),
      h('div', { class: 'meta' },
        h('span', {}, tasksText(group)),
        group.in_progress > 0 ? h('span', {}, `${group.in_progress} en curs`) : null,
        group.blocked > 0 ? h('span', {}, `${group.blocked} ${group.blocked === 1 ? 'bloquejada' : 'bloquejades'}`) : null,
        trend)),
    h('div', { class: 'rank-score' }, h('strong', {}, String(group.percent)), h('span', {}, '%')));
}

// The whole ranking for a project, ready to be placed in a page.
export async function rankingContent(projectId) {
  const data = await api.get(`/api/projects/${projectId}/ranking`);
  const el = h('div', { class: 'ranking' });
  if (data.groups.length === 0) {
    return append(el, h('div', { class: 'empty' }, 'Aquest projecte encara no té grups.'));
  }

  const leader = data.groups[0];
  const above = data.groups.filter((group) => group.percent > data.average_percent).length;
  return append(el,
    data.can_manage
      ? h('div', { class: 'notice' }, data.project.ranking_visible
          ? "L'alumnat també veu aquesta classificació, sense els noms de les persones dels altres grups."
          : "Ara només la veu el professorat. Per mostrar-la a l'alumnat, activa «Mostra la classificació» a «Edita el projecte».")
      : null,
    h('div', { class: 'rank-hero' },
      h('div', { class: 'rank-hero-title' }, h('span', { class: 'rank-trophy', 'aria-hidden': 'true' }, '🏆'),
        h('div', {}, h('h2', {}, 'Classificació'), h('p', {}, data.project.name))),
      h('div', { class: 'rank-stats' },
        h('div', {}, h('strong', {}, `${data.average_percent}%`), h('span', {}, 'Mitjana de la classe')),
        h('div', {}, h('strong', {}, leader.completed > 0 ? `${leader.percent}%` : '—'), h('span', {}, 'Millor grup')),
        h('div', {}, h('strong', {}, `${above} de ${data.groups.length}`), h('span', {}, 'Grups per sobre de la mitjana')))),
    podium(data.groups),
    h('ol', { class: 'rank-list' }, data.groups.map((group) => row(group, data))),
    h('p', { class: 'muted rank-legend' },
      h('span', { class: 'rank-average-key', 'aria-hidden': 'true' }),
      `La marca vertical de cada barra és la mitjana de la classe (${data.average_percent}%). Puntua el percentatge de tasques finalitzades; en cas d'empat, passa davant qui té més tasques en curs i qui ha acabat abans.`));
}

// Page for students, who have no project page of their own.
export async function renderStudentRanking(view, project) {
  append(view,
    h('div', { class: 'page-header' },
      h('div', { class: 'titles' },
        h('div', { class: 'breadcrumb' },
          h('a', { href: '#/' }, 'Els meus projectes'), ' / ',
          h('a', { href: `#/groups/${project.my_group_id}` }, project.name)),
        h('h1', {}, 'Classificació')),
      h('div', { class: 'actions' }, h('a', { class: 'btn', href: `#/groups/${project.my_group_id}` }, 'Torna al tauler'))),
    await rankingContent(project.id));
}
