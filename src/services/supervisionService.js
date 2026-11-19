import { db } from '../db/pool.js';
import * as groupRepo from '../repositories/groupRepository.js';
import * as tagRepo from '../repositories/tagRepository.js';
import * as supervisionRepo from '../repositories/supervisionRepository.js';
import * as taskRepo from '../repositories/taskRepository.js';
import * as userRepo from '../repositories/userRepository.js';
import { forbidden, notFound } from '../utils/errors.js';
import * as v from '../validators/index.js';
import { managerAccess, projectAccess } from './accessService.js';

// Progress matrix: one row per group, one column per shared task (in the
// global order), optionally filtered by tag.
export async function matrix(user, projectId, query) {
  const tagId = v.optionalId(query.tag_id, 'etiqueta');
  const { project } = await managerAccess(db, user, projectId);

  const [allTasks, groups, members, cells, tags] = await Promise.all([
    taskRepo.listByProject(db, projectId),
    groupRepo.listByProject(db, projectId),
    groupRepo.membersByProject(db, projectId),
    supervisionRepo.matrixCells(db, projectId),
    tagRepo.listForProject(db, projectId),
  ]);
  const taskTags = await tagRepo.mapForTasks(db, allTasks.map((t) => t.id));
  const tasks = allTasks.filter(
    (task) => tagId === null || taskTags.get(task.id).some((tag) => tag.id === tagId)
  );

  const byGroup = new Map(groups.map((g) => [g.id, {}]));
  for (const cell of cells) {
    byGroup.get(cell.group_id)[cell.task_id] = {
      group_task_id: cell.id,
      status: cell.status,
      responsible_name: cell.responsible_name,
    };
  }

  return {
    project: { id: project.id, name: project.name, status: project.status },
    tags,
    tasks: tasks.map((task, index) => ({
      id: task.id,
      position: index + 1,
      title: task.title,
      tags: taskTags.get(task.id),
    })),
    groups: groups.map((g) => ({
      id: g.id,
      group_number: g.group_number,
      name: g.name,
      students: members.get(g.id) || [],
      cells: byGroup.get(g.id),
    })),
  };
}

// ---- Teamwork badges ----------------------------------------------------------
// Every group can earn every badge: they reward how a group shares the work,
// never being ahead of another group. Working as a team does not mean doing
// every task together: it means everyone works, the work is shared fairly,
// and each person can handle different kinds of task and finish one alone.
//
// Each badge is a proportion over everything the group has finished so far,
// not a fixed number of tasks. So a badge is a picture of how the group works
// now: it is lost again when somebody stops pulling their weight.
// How far a person may be from an equal split of the finished tasks: 15%, and
// never less than one task, because tasks are whole and groups are small (one
// to six people). Everyone needs at least one finished task.
const SHARE_TOLERANCE = 0.15;
const MIN_TAG_COVERAGE = 0.5; // of the tags the group has worked on
const MIN_SOLO = 1 / 3; // of a person's own finished tasks
const MIN_PROJECT_TAGS = 2;

const percent = (ratio) => `${Math.round(ratio * 100)}%`;

function badges({ members, completions, memberTags, projectTags }) {
  const ids = members.map((m) => m.id);
  const size = ids.length;
  const of = (id) => completions.get(id) || { n: 0, solo: 0 };
  const finished = ids.reduce((sum, id) => sum + of(id).n, 0);
  const groupTags = new Set(ids.flatMap((id) => [...(memberTags.get(id) || [])]));

  // Everything is measured once there is, on average, a finished task per person.
  const enough = size > 0 && finished >= size;
  const waiting = `Encara no compta: ${finished} de ${size} tasques finalitzades`;
  const measured = (earned, progress) => (enough ? { earned, progress } : { earned: false, progress: waiting });

  // Tasks each person has finished, against an equal split with its tolerance:
  // 12 tasks among 3 people is 4 each, and between 3 and 5 is fine.
  const counts = ids.map((id) => of(id).n);
  const equal = size ? finished / size : 0;
  const margin = Math.max(1, equal * SHARE_TOLERANCE);
  const fewest = Math.max(1, Math.ceil(equal - margin));
  const most = Math.floor(equal + margin);
  const tasks = (n) => `${n} ${n === 1 ? 'tasca' : 'tasques'}`;
  // Part of the group's tags each person has worked on.
  const coverage = ids.map((id) => (groupTags.size ? (memberTags.get(id) || new Set()).size / groupTags.size : 0));
  // Part of each person's own finished tasks done without collaborators.
  const solo = ids.map((id) => (of(id).n ? of(id).solo / of(id).n : 0));
  const lowest = (values) => (values.length ? Math.min(...values) : 0);
  const highest = (values) => (values.length ? Math.max(...values) : 0);

  const list = [
    // Everyone works: nobody is far below their part.
    {
      key: 'everyone',
      ...measured(lowest(counts) >= fewest, `Qui menys: ${tasks(lowest(counts))} (mínim ${fewest})`),
    },
    // The work is shared fairly: nobody carries the group.
    {
      key: 'balanced',
      needs_team: true,
      ...measured(highest(counts) <= most, `Qui més: ${tasks(highest(counts))} (màxim ${most})`),
    },
    // Each person takes on tasks of different kinds (tags).
    {
      key: 'versatile',
      needs_tags: true,
      ...measured(
        groupTags.size > 0 && lowest(coverage) >= MIN_TAG_COVERAGE,
        `Qui menys: ${percent(lowest(coverage))} de les etiquetes (cal ${percent(MIN_TAG_COVERAGE)})`
      ),
    },
    // Each person carries tasks through alone too.
    {
      key: 'autonomous',
      ...measured(lowest(solo) >= MIN_SOLO, `Qui menys: ${percent(lowest(solo))} en solitari (cal ${percent(MIN_SOLO)})`),
    },
  ];
  return list.map(({ needs_team: team, needs_tags: tags, ...badge }) => {
    const reason = team && size < 2 ? 'team' : tags && projectTags < MIN_PROJECT_TAGS ? 'tags' : null;
    return reason ? { ...badge, earned: false, unavailable: reason, progress: '' } : badge;
  });
}

// Progress and teamwork badges of every group, in group order: there is no
// ranking. Staff always see it; students only when the project shows it, and
// then without the other groups' members or boards.
export async function ranking(user, projectId) {
  const access = await projectAccess(db, user, projectId);
  const { project } = access;
  if (!access.canManage && !project.ranking_visible) {
    throw forbidden("Les insígnies d'aquest projecte no són visibles per a l'alumnat.");
  }

  const [groups, members, progress, completions, memberTags, tags] = await Promise.all([
    groupRepo.listByProject(db, projectId),
    groupRepo.membersByProject(db, projectId),
    groupRepo.progressByProject(db, projectId),
    supervisionRepo.completionsByMember(db, projectId),
    supervisionRepo.tagsByMember(db, projectId),
    tagRepo.listForProject(db, projectId),
  ]);
  const of = (rows, groupId) => rows.filter((row) => row.group_id === groupId);

  const rows = groups.map((g) => {
    const p = progress.get(g.id) || { pending: 0, in_progress: 0, blocked: 0, completed: 0 };
    const total = p.pending + p.in_progress + p.blocked + p.completed;
    return {
      // Students get no way into another group's board.
      id: access.canManage || g.id === access.groupId ? g.id : null,
      group_number: g.group_number,
      name: g.name,
      is_mine: g.id === access.groupId,
      ...p,
      total,
      percent: total ? Math.round((p.completed / total) * 100) : 0,
      badges: badges({
        members: members.get(g.id) || [],
        completions: new Map(of(completions, g.id).map((row) => [row.user_id, { n: Number(row.n), solo: Number(row.solo) }])),
        memberTags: of(memberTags, g.id).reduce((map, row) => map.set(row.user_id, (map.get(row.user_id) || new Set()).add(row.tag_id)), new Map()),
        projectTags: tags.length,
      }),
    };
  });

  const all = rows.flatMap((row) => row.badges.filter((badge) => !badge.unavailable));
  return {
    project: { id: project.id, name: project.name, status: project.status, ranking_visible: Boolean(project.ranking_visible) },
    can_manage: access.canManage,
    my_group_id: access.groupId,
    // The class as a whole: the shared goal shown at the top.
    class_percent: rows.length ? Math.round(rows.reduce((sum, row) => sum + row.percent, 0) / rows.length) : 0,
    badges_earned: all.filter((badge) => badge.earned).length,
    badges_total: all.length,
    groups: rows,
  };
}

// Blocked tasks across the caller's projects (all projects for admins).
export async function blocked(user) {
  if (user.role === 'student') throw forbidden();
  return supervisionRepo.blockedTasks(db, user.role === 'admin' ? null : user.id);
}

// Everything a student actually did in a project. Responsibility and
// recorded actions are reported separately on purpose.
export async function contributions(user, projectId, studentId) {
  await managerAccess(db, user, projectId);
  const student = await userRepo.findById(db, studentId);
  if (!student || student.role !== 'student') throw notFound("No s'ha trobat l'alumne.");

  const [group, assigned, collaborating, completed, blockEvents, comments, transfers, activity] = await Promise.all([
    groupRepo.findStudentGroup(db, projectId, studentId),
    supervisionRepo.assignedTasks(db, projectId, studentId),
    supervisionRepo.collaboratingTasks(db, projectId, studentId),
    supervisionRepo.completedTasks(db, projectId, studentId),
    supervisionRepo.blockEvents(db, projectId, studentId),
    supervisionRepo.comments(db, projectId, studentId),
    supervisionRepo.transfers(db, projectId, studentId),
    supervisionRepo.recentActivity(db, projectId, studentId, 200),
  ]);

  return {
    student: { id: student.id, name: student.name, email: student.email },
    group: group ? { id: group.id, group_number: group.group_number, name: group.name } : null,
    assigned,
    collaborating,
    completed,
    block_events: blockEvents,
    comments,
    transfers,
    activity,
  };
}
