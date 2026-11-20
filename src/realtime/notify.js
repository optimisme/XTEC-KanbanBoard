// Tells the open boards that something changed, after any successful write
// through the REST API. What a write touches is worked out from the route
// parameters before the handler runs (afterwards the row may be gone), and
// the boards are told once the response has been sent, so the change is
// already committed when they read it again.
import { db } from '../db/pool.js';
import * as groupRepo from '../repositories/groupRepository.js';
import * as groupTaskRepo from '../repositories/groupTaskRepository.js';
import * as tagRepo from '../repositories/tagRepository.js';
import * as taskRepo from '../repositories/taskRepository.js';
import { publishGroup, publishProject, recheckUser } from './hub.js';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function target(resolve) {
  return async (req, res, next, value) => {
    if (!READ_METHODS.has(req.method) && /^\d{1,15}$/.test(value)) {
      const found = await resolve(Number(value)).catch(() => null);
      if (found) req.realtime = { ...req.realtime, ...found };
    }
    next();
  };
}

const projectOf = (find) => async (id) => {
  const row = await find(db, id);
  return row ? { projectId: row.project_id } : null;
};

export function notifyBoards(router) {
  router.param('projectId', target(async (id) => ({ projectId: id })));
  router.param('groupId', target(projectOf(groupRepo.findById)));
  router.param('taskId', target(projectOf(taskRepo.findById)));
  router.param('tagId', target(projectOf(tagRepo.findById)));
  router.param('groupTaskId', target(async (id) => {
    const row = await groupTaskRepo.findById(db, id);
    const group = row ? await groupRepo.findById(db, row.group_id) : null;
    return group ? { groupId: group.id, groupProjectId: group.project_id, taskId: id } : null;
  }));
  // /users/:id — the account itself changed.
  router.param('id', target(async (id) => ({ userId: id })));

  router.use((req, res, next) => {
    if (!READ_METHODS.has(req.method)) {
      res.on('finish', () => {
        const touched = req.realtime;
        if (!touched || res.statusCode >= 400) return;
        // The tab that made the change has already redrawn itself.
        const origin = String(req.get('x-client-id') || '').slice(0, 40);
        const actor = req.user ? req.user.id : null;
        if (touched.groupId) {
          publishGroup(touched.groupId, touched.groupProjectId,
            { type: 'board_changed', task_id: touched.taskId, origin, actor_id: actor });
        }
        if (touched.projectId) publishProject(touched.projectId, { type: 'board_changed', origin, actor_id: actor }).catch(() => {});
        if (touched.userId) recheckUser(touched.userId).catch(() => {});
      });
    }
    next();
  });
}
