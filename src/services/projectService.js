import { db } from '../db/pool.js';
import * as projectRepo from '../repositories/projectRepository.js';
import * as tagRepo from '../repositories/tagRepository.js';
import * as groupRepo from '../repositories/groupRepository.js';
import * as taskRepo from '../repositories/taskRepository.js';
import * as userRepo from '../repositories/userRepository.js';
import { badRequest, conflict, notFound } from '../utils/errors.js';
import { renderMarkdown } from '../utils/markdown.js';
import * as v from '../validators/index.js';
import { assertWritable, managerAccess, projectAccess, requireAdmin, requireStaff } from './accessService.js';
import { assertInstitutionalEmail } from './userService.js';

function parseProject(body) {
  return {
    name: v.text(body.name, 'nom', { max: 200 }),
    description: v.text(body.description, 'descripció', { max: 10000, required: false }),
    academicYear: v.academicYear(body.academic_year),
  };
}

export async function list(user) {
  let projects;
  if (user.role === 'admin') projects = await projectRepo.listAll(db);
  else if (user.role === 'teacher') projects = await projectRepo.listForTeacher(db, user.id);
  else projects = await projectRepo.listForStudent(db, user.id);

  const counts = await projectRepo.counts(db, projects.map((p) => p.id));
  return projects.map((p) => ({
    ...p,
    group_count: counts.get(p.id).groups,
    task_count: counts.get(p.id).tasks,
  }));
}

export async function get(user, projectId, executor = db) {
  const access = await projectAccess(executor, user, projectId);
  const { project } = access;

  const [tags, teachers, groups, members, progress, taskCount] = await Promise.all([
    tagRepo.listForProject(executor, projectId),
    projectRepo.teachers(executor, projectId),
    groupRepo.listByProject(executor, projectId),
    groupRepo.membersByProject(executor, projectId),
    groupRepo.progressByProject(executor, projectId),
    taskRepo.countActive(executor, projectId),
  ]);

  // Students only ever see their own group.
  const visibleGroups = access.level === 'student' ? groups.filter((g) => g.id === access.groupId) : groups;

  return {
    ...project,
    description_html: renderMarkdown(project.description),
    access: access.level,
    can_manage: access.canManage,
    my_group_id: access.groupId,
    tags,
    teachers,
    task_count: taskCount,
    groups: visibleGroups.map((g) => ({
      ...g,
      students: members.get(g.id) || [],
      progress: progress.get(g.id) || { pending: 0, in_progress: 0, blocked: 0, completed: 0 },
    })),
  };
}

// Administrators and teachers create projects. A teacher who creates one is
// assigned to it, which is what gives them access from then on.
export async function create(user, body) {
  requireStaff(user);
  const data = parseProject(body);
  const id = await db.tx(async (t) => {
    const projectId = await projectRepo.create(t, data);
    if (user.role === 'teacher') await projectRepo.addTeacher(t, projectId, user.id);
    return projectId;
  });
  return get(user, id);
}

export async function update(user, projectId, body) {
  await managerAccess(db, user, projectId);
  const data = parseProject(body);
  await db.tx(async (t) => {
    const project = await projectRepo.lock(t, projectId);
    if (!project) throw notFound("No s'ha trobat el projecte.");
    assertWritable(project);
    await projectRepo.update(t, projectId, data);
  });
  return get(user, projectId);
}

export async function setStatus(user, projectId, status) {
  await managerAccess(db, user, projectId);
  await projectRepo.setStatus(db, projectId, status);
  return get(user, projectId);
}

// Permanent deletion, for administrators only and only for archived projects:
// a project has to be archived first, so an active one can never be erased in
// a single step. It removes the project's tasks, groups, progress, comments
// and history.
export async function remove(user, projectId) {
  requireAdmin(user);
  await db.tx(async (t) => {
    const project = await projectRepo.lock(t, projectId);
    if (!project) throw notFound("No s'ha trobat el projecte.");
    if (project.status !== 'archived') {
      throw conflict('Només es poden esborrar projectes arxivats. Arxiva primer el projecte.', 'project_not_archived');
    }
    await projectRepo.removeCompletely(t, projectId);
  });
}

// A project's teachers (and administrators) can bring in another teacher by
// institutional email. An email without an account creates a teacher account
// (a name is then required); a pending account is approved as a teacher. An
// existing student, or a disabled account, is never turned into a teacher.
export async function addTeacher(user, projectId, body) {
  const email = v.email(body.email);
  assertInstitutionalEmail(email);
  const { project } = await managerAccess(db, user, projectId);
  assertWritable(project);

  await db.tx(async (t) => {
    let teacher = await userRepo.findByEmail(t, email);
    if (!teacher) {
      if (!body.name || !String(body.name).trim()) {
        throw badRequest(`${email} encara no té compte: cal indicar-ne el nom per crear-lo.`);
      }
      const name = v.text(body.name, 'nom', { max: 200 });
      const id = await userRepo.create(t, { issuer: null, subject: null, email, name, role: 'teacher', status: 'active' });
      teacher = { id, name };
    } else if (teacher.status === 'pending') {
      await userRepo.update(t, teacher.id, { role: 'teacher', status: 'active' });
    } else if (teacher.status !== 'active') {
      throw conflict(`El compte ${email} està desactivat. Contacta amb administració.`);
    } else if (teacher.role !== 'teacher') {
      throw conflict(`${email} no és un compte de professorat.`);
    }
    if (await projectRepo.isTeacher(t, projectId, teacher.id)) {
      throw conflict(`${teacher.name} ja és professor/a d'aquest projecte.`);
    }
    await projectRepo.addTeacher(t, projectId, teacher.id);
  });
  return get(user, projectId);
}

// Replacing the whole list of teachers (which can also remove them) is left
// to administrators.
export async function setTeachers(user, projectId, body) {
  requireAdmin(user);
  const teacherIds = v.idArray(body.teacher_ids, 'professorat');
  await db.tx(async (t) => {
    const project = await projectRepo.lock(t, projectId);
    if (!project) throw notFound("No s'ha trobat el projecte.");
    assertWritable(project);
    const users = await userRepo.findByIds(t, teacherIds);
    if (users.length !== teacherIds.length || users.some((u) => u.role !== 'teacher' || u.status !== 'active')) {
      throw badRequest('Només es pot assignar professorat amb el compte actiu.');
    }
    await projectRepo.setTeachers(t, projectId, teacherIds);
  });
  return get(user, projectId);
}

// Copies the reusable definition of a project (tags, shared tasks and
// their order) into a new project for another academic year. Teachers,
// groups, students and every piece of progress are deliberately left behind
// (a teacher who duplicates a project becomes the teacher of the copy).
export async function duplicate(user, projectId, body) {
  await managerAccess(db, user, projectId);
  const newId = await db.tx(async (t) => {
    const source = await projectRepo.findById(t, projectId);
    if (!source) throw notFound("No s'ha trobat el projecte.");

    const data = parseProject({
      name: body.name ?? `${source.name} (còpia)`.slice(0, 200),
      description: body.description ?? source.description ?? '',
      academic_year: body.academic_year ?? source.academic_year,
    });
    const id = await projectRepo.create(t, data);
    if (user.role === 'teacher') await projectRepo.addTeacher(t, id, user.id);

    // Tags are copied with their colors; old tag ids map to the new ones.
    const newTagId = new Map();
    for (const tag of await tagRepo.listForProject(t, projectId)) {
      newTagId.set(tag.id, await tagRepo.create(t, { projectId: id, name: tag.name, color: tag.color, textColor: tag.text_color }));
    }

    const tasks = await taskRepo.listByProject(t, projectId);
    const taskTags = await tagRepo.mapForTasks(t, tasks.map((task) => task.id));
    let sortOrder = 1;
    for (const task of tasks) {
      const copy = {
        projectId: id,
        title: task.title,
        description: task.description,
        sortOrder: sortOrder++,
        authorId: user.id,
      };
      const taskId = await taskRepo.create(t, copy);
      const copiedTags = taskTags.get(task.id).map((tag) => ({ id: newTagId.get(tag.id), name: tag.name }));
      await tagRepo.setTaskTags(t, taskId, id, copiedTags.map((tag) => tag.id));
      await taskRepo.insertVersion(t, {
        taskId,
        version: 1,
        ...copy,
        tags: copiedTags,
        userId: user.id,
      });
    }
    return id;
  });
  return get(user, newId);
}
