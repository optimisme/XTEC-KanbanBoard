import * as projectRepo from '../repositories/projectRepository.js';
import * as groupRepo from '../repositories/groupRepository.js';
import * as groupTaskRepo from '../repositories/groupTaskRepository.js';
import { conflict, forbidden, notFound } from '../utils/errors.js';

// Central authorization rules. Every service resolves access through these
// functions, so the rules live in exactly one place:
//   admin   -> every project
//   teacher -> projects listed in project_teachers (never by module); a
//              teacher manages those projects fully and can create new ones
//   student -> only their own group inside a project

export async function projectAccess(db, user, projectId) {
  const project = await projectRepo.findById(db, projectId);
  if (!project) throw notFound("No s'ha trobat el projecte.");

  if (user.role === 'admin') return { project, level: 'admin', canManage: true, groupId: null };
  if (user.role === 'teacher' && (await projectRepo.isTeacher(db, projectId, user.id))) {
    return { project, level: 'teacher', canManage: true, groupId: null };
  }
  if (user.role === 'student') {
    const group = await groupRepo.findStudentGroup(db, projectId, user.id);
    if (group) return { project, level: 'student', canManage: false, groupId: group.id };
  }
  throw forbidden('No tens accés a aquest projecte.');
}

export async function groupAccess(db, user, groupId) {
  const group = await groupRepo.findById(db, groupId);
  if (!group) throw notFound("No s'ha trobat el grup.");
  const access = await projectAccess(db, user, group.project_id);
  if (access.level === 'student' && access.groupId !== group.id) {
    throw forbidden('No tens accés a aquest grup.');
  }
  return { ...access, group };
}

export async function groupTaskAccess(db, user, groupTask) {
  if (!groupTask) throw notFound("No s'ha trobat la tasca.");
  return groupAccess(db, user, groupTask.group_id);
}

export async function groupTaskAccessById(db, user, groupTaskId) {
  const groupTask = await groupTaskRepo.findById(db, groupTaskId);
  const access = await groupTaskAccess(db, user, groupTask);
  return { ...access, groupTask };
}

// Teachers of the project and administrators only.
export async function managerAccess(db, user, projectId) {
  const access = await projectAccess(db, user, projectId);
  if (!access.canManage) throw forbidden();
  return access;
}

// Administrators and teachers (for actions not tied to an existing project).
export function requireStaff(user) {
  if (user.role !== 'admin' && user.role !== 'teacher') throw forbidden();
}

export function requireAdmin(user) {
  if (user.role !== 'admin') throw forbidden('Només les persones administradores poden fer aquesta acció.');
}

// Archived projects are read-only until an administrator reactivates them.
export function assertWritable(project) {
  if (project.status === 'archived') {
    throw conflict('El projecte està arxivat i és només de lectura.', 'project_archived');
  }
}
