import { db } from '../db/pool.js';
import * as groupRepo from '../repositories/groupRepository.js';
import * as moduleRepo from '../repositories/moduleRepository.js';
import * as supervisionRepo from '../repositories/supervisionRepository.js';
import * as taskRepo from '../repositories/taskRepository.js';
import * as userRepo from '../repositories/userRepository.js';
import { forbidden, notFound } from '../utils/errors.js';
import * as v from '../validators/index.js';
import { managerAccess } from './accessService.js';

// Progress matrix: one row per group, one column per shared task (in the
// global order), optionally filtered by professional module.
export async function matrix(user, projectId, query) {
  const moduleId = v.optionalId(query.module_id, 'mòdul');
  const { project } = await managerAccess(db, user, projectId);

  const [allTasks, groups, members, cells, modules] = await Promise.all([
    taskRepo.listByProject(db, projectId),
    groupRepo.listByProject(db, projectId),
    groupRepo.membersByProject(db, projectId),
    supervisionRepo.matrixCells(db, projectId),
    moduleRepo.listForProject(db, projectId),
  ]);
  const taskModules = await moduleRepo.mapForTasks(db, allTasks.map((t) => t.id));
  const tasks = allTasks.filter(
    (task) => moduleId === null || taskModules.get(task.id).some((m) => m.id === moduleId)
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
    modules,
    tasks: tasks.map((task, index) => ({
      id: task.id,
      position: index + 1,
      title: task.title,
      modules: taskModules.get(task.id),
    })),
    groups: groups.map((g) => ({
      id: g.id,
      group_number: g.group_number,
      students: members.get(g.id) || [],
      cells: byGroup.get(g.id),
    })),
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

  const [group, assigned, completed, blockEvents, comments, attachments, transfers, activity] = await Promise.all([
    groupRepo.findStudentGroup(db, projectId, studentId),
    supervisionRepo.assignedTasks(db, projectId, studentId),
    supervisionRepo.completedTasks(db, projectId, studentId),
    supervisionRepo.blockEvents(db, projectId, studentId),
    supervisionRepo.comments(db, projectId, studentId),
    supervisionRepo.attachments(db, projectId, studentId),
    supervisionRepo.transfers(db, projectId, studentId),
    supervisionRepo.recentActivity(db, projectId, studentId, 200),
  ]);

  return {
    student: { id: student.id, name: student.name, email: student.email },
    group: group ? { id: group.id, group_number: group.group_number } : null,
    assigned,
    completed,
    block_events: blockEvents,
    comments,
    attachments,
    transfers,
    activity,
  };
}
