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

// Ranking of the project's groups by share of completed tasks, with the class
// average. Staff always see it; students only when the project shows it, and
// then without the other groups' members or boards.
export async function ranking(user, projectId) {
  const access = await projectAccess(db, user, projectId);
  const { project } = access;
  if (!access.canManage && !project.ranking_visible) {
    throw forbidden("La classificació d'aquest projecte no és visible per a l'alumnat.");
  }

  const [groups, progress, lastCompletion] = await Promise.all([
    groupRepo.listByProject(db, projectId),
    groupRepo.progressByProject(db, projectId),
    groupRepo.lastCompletionByProject(db, projectId),
  ]);

  const rows = groups.map((g) => {
    const p = progress.get(g.id) || { pending: 0, in_progress: 0, blocked: 0, completed: 0 };
    const total = p.pending + p.in_progress + p.blocked + p.completed;
    const last = lastCompletion.get(g.id);
    return {
      // Students get no way into another group's board.
      id: access.canManage || g.id === access.groupId ? g.id : null,
      group_number: g.group_number,
      name: g.name,
      is_mine: g.id === access.groupId,
      ...p,
      total,
      percent: total ? Math.round((p.completed / total) * 100) : 0,
      last: last ? new Date(last).getTime() : Number.MAX_SAFE_INTEGER,
    };
  });

  // More completed first; then more in progress; then whoever got there earlier.
  const order = (a, b) => b.completed - a.completed || b.in_progress - a.in_progress || a.last - b.last;
  rows.sort((a, b) => order(a, b) || a.group_number - b.group_number);
  rows.forEach((row, index) => {
    const previous = rows[index - 1];
    row.position = previous && order(previous, row) === 0 ? previous.position : index + 1;
  });

  const average = rows.length ? Math.round(rows.reduce((sum, row) => sum + row.percent, 0) / rows.length) : 0;
  return {
    project: { id: project.id, name: project.name, status: project.status, ranking_visible: Boolean(project.ranking_visible) },
    can_manage: access.canManage,
    my_group_id: access.groupId,
    average_percent: average,
    groups: rows.map(({ last, ...row }) => row),
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
