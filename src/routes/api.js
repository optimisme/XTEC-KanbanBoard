import { Router } from 'express';
import * as admin from '../controllers/adminController.js';
import * as auth from '../controllers/authController.js';
import * as groupTasks from '../controllers/groupTaskController.js';
import * as projects from '../controllers/projectController.js';
import { requireActive, requireRole } from '../middleware/auth.js';

const router = Router();
const adminOnly = requireRole('admin');
const staffOnly = requireRole('admin', 'teacher');

// Session (available before approval so the UI can show the account state).
router.get('/session', auth.session);

// Everything below requires an approved, active account. Project, group and
// task permissions are then enforced inside the services.
router.use(requireActive);

router.patch('/profile', admin.updateProfile);
router.put('/profile/password', admin.setPassword);

// Users
router.get('/users', adminOnly, admin.listUsers);
router.post('/users', adminOnly, admin.createUser);
router.patch('/users/:id', adminOnly, admin.updateUser);
router.post('/users/:id/approve', adminOnly, admin.approveUser);
router.post('/users/:id/reject', adminOnly, admin.rejectUser);

// Used by teachers and administrators when adding people by email.
router.post('/students/lookup', staffOnly, admin.lookupStudent);
router.post('/teachers/lookup', staffOnly, admin.lookupTeacher);

// Project tags
router.get('/projects/:projectId/tags', projects.listTags);
router.get('/projects/:projectId/tags/suggestions', projects.tagSuggestions);
router.post('/projects/:projectId/tags', projects.createTag);
router.put('/tags/:tagId', projects.updateTag);
router.delete('/tags/:tagId', projects.deleteTag);

// Projects
router.get('/projects', projects.list);
router.post('/projects', projects.create);
router.get('/projects/:projectId', projects.get);
router.put('/projects/:projectId', projects.update);
router.post('/projects/:projectId/archive', projects.archive);
router.post('/projects/:projectId/unarchive', projects.unarchive);
router.post('/projects/:projectId/duplicate', projects.duplicate);
router.put('/projects/:projectId/teachers', projects.setTeachers);
router.post('/projects/:projectId/teachers', projects.addTeacher);

// Groups
router.post('/projects/:projectId/groups', projects.createGroup);
router.put('/groups/:groupId/students', projects.setGroupStudents);
router.delete('/groups/:groupId', projects.deleteGroup);
router.put('/groups/:groupId/github', projects.setGithubUrl);
router.get('/groups/:groupId/board', groupTasks.board);

// Shared task definitions
router.get('/projects/:projectId/tasks', projects.listTasks);
router.post('/projects/:projectId/tasks', projects.createTask);
router.put('/projects/:projectId/tasks/order', projects.reorderTasks);
router.get('/tasks/:taskId', projects.getTask);
router.put('/tasks/:taskId', projects.updateTask);
router.delete('/tasks/:taskId', projects.deleteTask);
router.get('/tasks/:taskId/versions', projects.taskVersions);

// Initial Markdown import
router.get('/projects/:projectId/import/template', projects.importTemplate);
router.post('/projects/:projectId/import/preview', projects.importPreview);
router.post('/projects/:projectId/import', projects.importTasks);

// Group tasks (Kanban)
router.get('/group-tasks/:groupTaskId', groupTasks.detail);
router.post('/group-tasks/:groupTaskId/status', groupTasks.changeStatus);
router.post('/group-tasks/:groupTaskId/responsible', groupTasks.transferResponsibility);
router.post('/group-tasks/:groupTaskId/comments', groupTasks.addComment);
router.get('/group-tasks/:groupTaskId/history', groupTasks.history);

// Supervision
router.get('/projects/:projectId/matrix', projects.matrix);
router.get('/blocked-tasks', projects.blockedTasks);
router.get('/projects/:projectId/students/:userId/contributions', projects.contributions);

export default router;
