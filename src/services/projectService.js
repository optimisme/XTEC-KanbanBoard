import { db } from '../db/pool.js';
import * as projectRepo from '../repositories/projectRepository.js';
import * as moduleRepo from '../repositories/moduleRepository.js';
import * as groupRepo from '../repositories/groupRepository.js';
import * as taskRepo from '../repositories/taskRepository.js';
import * as userRepo from '../repositories/userRepository.js';
import { badRequest, conflict, notFound } from '../utils/errors.js';
import { renderMarkdown } from '../utils/markdown.js';
import * as v from '../validators/index.js';
import { assertWritable, projectAccess, requireAdmin } from './accessService.js';

function parseProject(body) {
  return {
    name: v.text(body.name, 'nom', { max: 200 }),
    description: v.text(body.description, 'descripció', { max: 10000, required: false }),
    academicYear: v.academicYear(body.academic_year),
  };
}

async function validModuleIds(t, value) {
  const moduleIds = v.idArray(value ?? [], 'mòduls');
  const found = await moduleRepo.findByIds(t, moduleIds);
  if (found.length !== moduleIds.length) throw badRequest('Algun dels mòduls indicats no existeix.');
  return moduleIds;
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

  const [modules, teachers, groups, members, progress, taskCount] = await Promise.all([
    moduleRepo.listForProject(executor, projectId),
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
    modules,
    teachers,
    task_count: taskCount,
    groups: visibleGroups.map((g) => ({
      ...g,
      students: members.get(g.id) || [],
      progress: progress.get(g.id) || { pending: 0, in_progress: 0, blocked: 0, completed: 0 },
    })),
  };
}

export async function create(user, body) {
  requireAdmin(user);
  const data = parseProject(body);
  const id = await db.tx(async (t) => {
    const moduleIds = await validModuleIds(t, body.module_ids);
    const projectId = await projectRepo.create(t, data);
    await moduleRepo.addToProject(t, projectId, moduleIds);
    return projectId;
  });
  return get(user, id);
}

export async function update(user, projectId, body) {
  requireAdmin(user);
  const data = parseProject(body);
  await db.tx(async (t) => {
    const project = await projectRepo.lock(t, projectId);
    if (!project) throw notFound("No s'ha trobat el projecte.");
    assertWritable(project);
    await projectRepo.update(t, projectId, data);

    if (body.module_ids !== undefined) {
      const wanted = await validModuleIds(t, body.module_ids);
      const current = (await moduleRepo.listForProject(t, projectId)).map((m) => m.id);
      await moduleRepo.addToProject(t, projectId, wanted.filter((id) => !current.includes(id)));
      try {
        await moduleRepo.removeFromProject(t, projectId, current.filter((id) => !wanted.includes(id)));
      } catch (err) {
        if (err.code === 'ER_ROW_IS_REFERENCED_2') {
          throw conflict('No es pot treure un mòdul que encara tenen assignat algunes tasques.');
        }
        throw err;
      }
    }
  });
  return get(user, projectId);
}

export async function setStatus(user, projectId, status) {
  requireAdmin(user);
  if (!(await projectRepo.findById(db, projectId))) throw notFound("No s'ha trobat el projecte.");
  await projectRepo.setStatus(db, projectId, status);
  return get(user, projectId);
}

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

// Copies the reusable definition of a project (modules, shared tasks and
// their order) into a new project for another academic year. Teachers,
// groups, students and every piece of progress are deliberately left behind.
export async function duplicate(user, projectId, body) {
  requireAdmin(user);
  const newId = await db.tx(async (t) => {
    const source = await projectRepo.findById(t, projectId);
    if (!source) throw notFound("No s'ha trobat el projecte.");

    const data = parseProject({
      name: body.name ?? `${source.name} (còpia)`.slice(0, 200),
      description: body.description ?? source.description ?? '',
      academic_year: body.academic_year ?? source.academic_year,
    });
    const id = await projectRepo.create(t, data);

    const modules = await moduleRepo.listForProject(t, projectId);
    await moduleRepo.addToProject(t, id, modules.map((m) => m.id));

    const tasks = await taskRepo.listByProject(t, projectId);
    const taskModules = await moduleRepo.mapForTasks(t, tasks.map((task) => task.id));
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
      const copiedModules = taskModules.get(task.id);
      await taskRepo.setModules(t, taskId, id, copiedModules.map((m) => m.id));
      await taskRepo.insertVersion(t, {
        taskId,
        version: 1,
        ...copy,
        modules: copiedModules.map((m) => ({ id: m.id, name: m.name })),
        userId: user.id,
      });
    }
    return id;
  });
  return get(user, newId);
}
