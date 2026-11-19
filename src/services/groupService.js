import { db } from '../db/pool.js';
import * as projectRepo from '../repositories/projectRepository.js';
import * as groupRepo from '../repositories/groupRepository.js';
import * as groupTaskRepo from '../repositories/groupTaskRepository.js';
import * as userRepo from '../repositories/userRepository.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors.js';
import * as v from '../validators/index.js';
import { assertWritable, groupAccess, managerAccess } from './accessService.js';
import { clearCollaborators } from './groupTaskService.js';
import * as projectService from './projectService.js';
import { assertInstitutionalEmail } from './userService.js';

const MAX_STUDENTS_PER_REQUEST = 60;

// Turns the request into a list of student ids. Students can be given by id
// (`student_ids`) or by email (`students: [{ email, name? }]`). An email that
// is not registered yet creates the student account, which needs a name; the
// student then signs in with that institutional email without approval.
async function resolveStudents(t, body) {
  const ids = body.student_ids === undefined ? [] : v.idArray(body.student_ids, 'alumnat');
  const entries = body.students === undefined ? [] : body.students;
  if (!Array.isArray(entries) || entries.length > MAX_STUDENTS_PER_REQUEST) {
    throw badRequest("La llista d'alumnat no és vàlida.");
  }

  for (const entry of entries) {
    const email = v.email(entry && entry.email);
    assertInstitutionalEmail(email);
    const existing = await userRepo.findByEmail(t, email);

    if (!existing) {
      if (!entry.name || !String(entry.name).trim()) {
        throw badRequest(`${email} encara no té compte: cal indicar-ne el nom per crear-lo.`);
      }
      const name = v.text(entry.name, 'nom', { max: 200 });
      ids.push(await userRepo.create(t, { issuer: null, subject: null, email, name, role: 'student', status: 'active' }));
    } else if (existing.role !== 'student') {
      throw conflict(`${email} no és un compte d'alumnat.`);
    } else if (existing.status === 'pending') {
      // Adding a pending student to a group is the approval.
      await userRepo.update(t, existing.id, { status: 'active' });
      ids.push(existing.id);
    } else if (existing.status !== 'active') {
      throw conflict(`El compte ${email} està desactivat. Contacta amb administració.`);
    } else {
      ids.push(existing.id);
    }
  }

  const unique = [...new Set(ids)];
  // An active group always has at least one student.
  if (unique.length === 0) throw badRequest('El grup ha de tenir almenys una persona.');
  return unique;
}

// Students being added must be active students that are not yet in another
// group of the same project (also guaranteed by a unique key).
async function assertAssignable(t, projectId, groupId, studentIds) {
  const users = await userRepo.findByIds(t, studentIds);
  if (users.length !== studentIds.length || users.some((u) => u.role !== 'student' || u.status !== 'active')) {
    throw badRequest('Només es pot assignar alumnat amb el compte actiu.');
  }
  for (const user of users) {
    const existing = await groupRepo.findStudentGroup(t, projectId, user.id);
    if (existing && existing.id !== groupId) {
      throw conflict(`${user.name} ja pertany al grup ${existing.group_number} d'aquest projecte.`);
    }
  }
}

// Groups are managed by administrators and by the project's teachers.
export async function create(user, projectId, body) {
  await db.tx(async (t) => {
    // The project lock serializes group numbering and task propagation.
    const project = await projectRepo.lock(t, projectId);
    if (!project) throw notFound("No s'ha trobat el projecte.");
    await managerAccess(t, user, projectId);
    assertWritable(project);
    const studentIds = await resolveStudents(t, body);
    await assertAssignable(t, projectId, null, studentIds);

    const groupId = await groupRepo.create(t, projectId, await groupRepo.nextNumber(t, projectId));
    await groupRepo.addStudents(t, groupId, projectId, studentIds);
    // The new group receives every shared task, pending and unassigned.
    await groupTaskRepo.createForGroup(t, groupId, projectId);
  });
  return projectService.get(user, projectId);
}

export async function setStudents(user, groupId, body) {
  const projectId = await db.tx(async (t) => {
    const group = await groupRepo.findById(t, groupId);
    if (!group) throw notFound("No s'ha trobat el grup.");
    const project = await projectRepo.lock(t, group.project_id);
    await managerAccess(t, user, group.project_id);
    assertWritable(project);

    const wanted = await resolveStudents(t, body);
    const current = (await groupRepo.members(t, groupId)).map((m) => m.id);
    const toAdd = wanted.filter((id) => !current.includes(id));
    const toRemove = current.filter((id) => !wanted.includes(id));
    await assertAssignable(t, group.project_id, groupId, toAdd);
    await groupRepo.addStudents(t, groupId, group.project_id, toAdd);

    // A student who leaves keeps their history, but stops being responsible.
    for (const studentId of toRemove) {
      for (const { id } of await groupTaskRepo.listAssignedTo(t, groupId, studentId)) {
        await groupTaskRepo.update(t, id, { responsible_user_id: null, assigned_at: null });
        await groupTaskRepo.addHistory(t, {
          groupTaskId: id,
          actorId: user.id,
          eventType: 'responsibility_transferred',
          oldValue: studentId,
        });
        // No responsible, no collaborators.
        await clearCollaborators(t, id, user.id);
      }
      for (const { group_task_id: id } of await groupTaskRepo.collaborationsOf(t, groupId, studentId)) {
        await groupTaskRepo.removeCollaborator(t, id, studentId);
        await groupTaskRepo.addHistory(t, { groupTaskId: id, actorId: user.id, eventType: 'collaborator_removed', oldValue: studentId });
      }
    }
    await groupRepo.removeStudents(t, groupId, toRemove);
    return group.project_id;
  });
  return projectService.get(user, projectId);
}

// Only groups without any recorded activity can be deleted; anything else
// would destroy history.
export async function remove(user, groupId) {
  const projectId = await db.tx(async (t) => {
    const group = await groupRepo.findById(t, groupId);
    if (!group) throw notFound("No s'ha trobat el grup.");
    const project = await projectRepo.lock(t, group.project_id);
    await managerAccess(t, user, group.project_id);
    assertWritable(project);
    if (await groupRepo.hasActivity(t, groupId)) {
      throw conflict("No es pot eliminar un grup que ja té activitat. Arxiva el projecte per conservar-ne l'historial.");
    }
    await groupTaskRepo.removeForGroup(t, groupId);
    await groupRepo.remove(t, groupId);
    return group.project_id;
  });
  return projectService.get(user, projectId);
}

// The repository URL is configured by the group's own students (and admins).
export async function setGithubUrl(user, groupId, body) {
  const url = v.githubRepoUrl(body.github_url);
  const access = await groupAccess(db, user, groupId);
  if (access.level === 'teacher') throw forbidden("Només l'alumnat del grup pot configurar el repositori.");
  assertWritable(access.project);
  await groupRepo.setGithubUrl(db, groupId, url);
  return { id: groupId, github_url: url };
}
