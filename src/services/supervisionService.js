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
const VERSATILE_TAGS = 2;
const BALANCE_TASKS_EACH = 2;
const BALANCE_MAX_GAP = 2;

function badges({ members, completions, projectTags }) {
  const ids = members.map((m) => m.id);
  const size = ids.length;
  const people = (n) => `${n} de ${size} ${size === 1 ? 'persona' : 'persones'}`;
  const of = (id) => completions.get(id) || { n: 0, solo: 0, tags: 0 };
  const howMany = (test) => ids.filter(test).length;

  const working = howMany((id) => of(id).n > 0);
  const versatile = howMany((id) => of(id).tags >= VERSATILE_TAGS);
  const autonomous = howMany((id) => of(id).solo > 0);
  const counts = ids.map((id) => of(id).n);
  const finished = counts.reduce((sum, n) => sum + n, 0);
  const gap = size ? Math.max(...counts) - Math.min(...counts) : 0;
  const balanceGoal = BALANCE_TASKS_EACH * size;

  const list = [
    // Everyone works on the project.
    { key: 'everyone', earned: size > 0 && working === size, progress: people(working) },
    // The finished tasks are shared out fairly.
    {
      key: 'balanced',
      needs_team: true,
      earned: finished >= balanceGoal && gap <= BALANCE_MAX_GAP,
      progress: finished < balanceGoal
        ? `${finished} de ${balanceGoal} tasques finalitzades`
        : `${gap} tasques de diferència`,
    },
    // Each person can take on tasks of different kinds (tags).
    { key: 'versatile', needs_tags: true, earned: size > 0 && versatile === size, progress: people(versatile) },
    // Each person can carry a task through alone.
    { key: 'autonomous', earned: size > 0 && autonomous === size, progress: people(autonomous) },
  ];
  return list.map(({ needs_team: team, needs_tags: tags, ...badge }) => {
    const reason = team && size < 2 ? 'team' : tags && projectTags < VERSATILE_TAGS ? 'tags' : null;
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

  const [groups, members, progress, completions, tags] = await Promise.all([
    groupRepo.listByProject(db, projectId),
    groupRepo.membersByProject(db, projectId),
    groupRepo.progressByProject(db, projectId),
    supervisionRepo.completionsByMember(db, projectId),
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
        completions: new Map(of(completions, g.id).map((row) => [row.user_id, { n: Number(row.n), solo: Number(row.solo), tags: Number(row.tags) }])),
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
