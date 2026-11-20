// Real-time channel (WebSocket, path /ws). It never carries board data and
// never changes anything: every change still goes through the REST API with
// its CSRF token, row lock and permission checks. The channel only tells the
// browsers looking at a board that it changed (they read it again through the
// API, which builds each card for the person asking), who else is looking at
// it, and which card somebody is dragging right now.
//
// Rooms live in memory: the application runs as a single process.
import { WebSocketServer } from 'ws';
import config from '../config/index.js';
import { db } from '../db/pool.js';
import * as userRepo from '../repositories/userRepository.js';
import { groupAccess, projectAccess } from '../services/accessService.js';
import { STATUSES } from '../services/groupTaskService.js';

const PATH = '/ws';
const MAX_MESSAGE_BYTES = 1024;
const MAX_SOCKETS_PER_USER = 10;
const MAX_WATCHED_PROJECTS = 100;
const MAX_MESSAGES_PER_WINDOW = 100;
const RATE_WINDOW_MS = 10 * 1000;
// Proxies drop silent connections (Cloudflare after about 100 seconds).
const HEARTBEAT_MS = 30 * 1000;
// A socket lives for hours, so its permissions are checked again regularly.
const RECHECK_MS = 60 * 1000;

// Close codes the browser understands.
export const CLOSE_SIGNED_OUT = 4401;
export const CLOSE_DENIED = 4403;

const clients = new Set();
let sessionStore = null;

const send = (ws, message) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
};
const inGroup = (groupId) => [...clients].filter((ws) => ws.state.room && ws.state.room.groupId === groupId);
const inProject = (projectId) => [...clients].filter((ws) => ws.state.room && ws.state.room.projectId === projectId);
// Pages that follow whole projects (matrix, badges, blocked tasks).
const watching = (projectId) => [...clients].filter((ws) => ws.state.watch.has(projectId));

function broadcast(groupId, message, except = null) {
  for (const ws of inGroup(groupId)) if (ws !== except) send(ws, message);
}

// The people looking at a board, each one once however many tabs they have.
function presence(groupId) {
  const people = new Map();
  for (const ws of inGroup(groupId)) people.set(ws.state.user.id, ws.state.user);
  return [...people.values()];
}

// The cards being dragged on a board right now.
function drags(groupId, except) {
  return inGroup(groupId)
    .filter((ws) => ws !== except && ws.state.drag)
    .map((ws) => ({ user: ws.state.user, ...ws.state.drag }));
}

function endDrag(ws) {
  if (!ws.state.drag || !ws.state.room) return;
  ws.state.drag = null;
  broadcast(ws.state.room.groupId, { type: 'drag_end', user_id: ws.state.user.id }, ws);
}

function leave(ws) {
  const { room } = ws.state;
  if (!room) return;
  endDrag(ws);
  ws.state.room = null;
  broadcast(room.groupId, { type: 'presence', people: presence(room.groupId) });
}

async function subscribe(ws, groupId) {
  leave(ws);
  let access;
  try {
    access = await groupAccess(db, ws.state.account, groupId);
  } catch {
    return send(ws, { type: 'denied', group_id: groupId });
  }
  ws.state.room = { groupId, projectId: access.project.id };
  send(ws, { type: 'subscribed', group_id: groupId, people: presence(groupId), drags: drags(groupId, ws) });
  return broadcast(groupId, { type: 'presence', people: presence(groupId) }, ws);
}

// Follows whole projects instead of one board. The list replaces the previous
// one, and only the projects the person can see are kept.
async function watch(ws, projectIds) {
  const allowed = new Set();
  for (const projectId of projectIds) {
    try {
      await projectAccess(db, ws.state.account, projectId);
      allowed.add(projectId);
    } catch {
      // Not theirs: left out.
    }
  }
  ws.state.watch = allowed;
  send(ws, { type: 'watching', project_ids: [...allowed] });
}

async function onMessage(ws, raw) {
  const now = Date.now();
  if (now - ws.state.windowStart > RATE_WINDOW_MS) {
    ws.state.windowStart = now;
    ws.state.messages = 0;
  }
  ws.state.messages += 1;
  if (ws.state.messages > MAX_MESSAGES_PER_WINDOW) return ws.close(1008, 'rate');

  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    return undefined;
  }
  if (!message || typeof message !== 'object') return undefined;

  if (message.type === 'subscribe' && Number.isSafeInteger(message.group_id) && message.group_id > 0) {
    return subscribe(ws, message.group_id);
  }
  if (message.type === 'watch' && Array.isArray(message.project_ids) && message.project_ids.length <= MAX_WATCHED_PROJECTS
    && message.project_ids.every((id) => Number.isSafeInteger(id) && id > 0)) {
    return watch(ws, message.project_ids);
  }
  if (!ws.state.room) return undefined;
  if (message.type === 'drag' && Number.isSafeInteger(message.task_id) && message.task_id > 0) {
    const status = STATUSES.includes(message.status) ? message.status : null;
    ws.state.drag = { task_id: message.task_id, status };
    // The name always comes from the server, never from the message.
    return broadcast(ws.state.room.groupId, { type: 'drag', user: ws.state.user, task_id: message.task_id, status }, ws);
  }
  if (message.type === 'drag_end') return endDrag(ws);
  return undefined;
}

const sessionExists = (sessionId) =>
  new Promise((resolve) => sessionStore.get(sessionId, (err, session) => resolve(Boolean(!err && session && session.userId))));

// Applies what the REST API applies on every request: the session is still
// open, the account is still active and the board is still theirs to see.
async function recheck(ws) {
  try {
    if (!(await sessionExists(ws.state.sessionId))) return ws.close(CLOSE_SIGNED_OUT, 'signed out');
    const account = await userRepo.findById(db, ws.state.user.id);
    if (!account || account.status !== 'active') return ws.close(CLOSE_DENIED, 'denied');
    ws.state.account = account;
    ws.state.user = { id: account.id, name: account.name, role: account.role };
    if (ws.state.room) await groupAccess(db, account, ws.state.room.groupId);
    for (const projectId of [...ws.state.watch]) {
      try {
        await projectAccess(db, account, projectId);
      } catch {
        // One last notice, so the page reads again and finds out it lost access.
        ws.state.watch.delete(projectId);
        send(ws, { type: 'project_changed', project_id: projectId, origin: '' });
      }
    }
  } catch {
    return ws.close(CLOSE_DENIED, 'denied');
  }
  return true;
}

// ---- Used by the REST API ---------------------------------------------------------

// A task of one group changed: its board is told, and so are the pages that
// follow the whole project.
export function publishGroup(groupId, projectId, message) {
  broadcast(groupId, message);
  for (const ws of watching(projectId)) {
    send(ws, { ...message, type: 'project_changed', project_id: projectId, group_id: groupId });
  }
}

// Something shared by the whole project changed (tasks, tags, members, the
// project itself). It may have changed who can see what, so every socket is
// checked again before it is told.
export async function publishProject(projectId, message) {
  await Promise.all(
    [...new Set([...inProject(projectId), ...watching(projectId)])].map(async (ws) => {
      if ((await recheck(ws)) !== true) return;
      if (ws.state.room && ws.state.room.projectId === projectId) send(ws, message);
      if (ws.state.watch.has(projectId)) send(ws, { ...message, type: 'project_changed', project_id: projectId });
    })
  );
}

// An account was disabled, deleted or given another role.
export async function recheckUser(userId) {
  await Promise.all([...clients].filter((ws) => ws.state.user.id === userId).map(recheck));
}

export function closeSession(sessionId) {
  for (const ws of clients) if (ws.state.sessionId === sessionId) ws.close(CLOSE_SIGNED_OUT, 'signed out');
}

// ---- Connection ---------------------------------------------------------------------

function refuse(socket, status, text) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

// Attaches the channel to the HTTP server. Returns a function that closes it.
export function attachRealtime(server, app) {
  const allowedOrigin = new URL(config.appUrl).origin;
  const { sessionParser } = app.locals;
  sessionStore = app.locals.sessionStore;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    if (new URL(req.url, 'http://localhost').pathname !== PATH) return refuse(socket, 404, 'Not Found');
    // A handshake carries no CSRF token: the page that opens it must be ours.
    if (req.headers.origin !== allowedOrigin) return refuse(socket, 403, 'Forbidden');

    // The same session cookie as the rest of the application.
    return sessionParser(req, { getHeader() {}, setHeader() {} }, async () => {
      try {
        const account = req.session && req.session.userId ? await userRepo.findById(db, req.session.userId) : null;
        if (!account || account.status !== 'active') return refuse(socket, 401, 'Unauthorized');
        const open = [...clients].filter((ws) => ws.state.user.id === account.id).length;
        if (open >= MAX_SOCKETS_PER_USER) return refuse(socket, 429, 'Too Many Requests');

        return wss.handleUpgrade(req, socket, head, (ws) => {
          ws.state = {
            account,
            user: { id: account.id, name: account.name, role: account.role },
            sessionId: req.sessionID,
            room: null,
            watch: new Set(),
            drag: null,
            alive: true,
            messages: 0,
            windowStart: Date.now(),
          };
          clients.add(ws);
          ws.on('pong', () => { ws.state.alive = true; });
          ws.on('message', (raw) => onMessage(ws, raw).catch(() => {}));
          ws.on('error', () => {});
          ws.on('close', () => {
            leave(ws);
            clients.delete(ws);
          });
          send(ws, { type: 'ready' });
        });
      } catch {
        return refuse(socket, 500, 'Internal Server Error');
      }
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of clients) {
      if (!ws.state.alive) ws.terminate();
      else {
        ws.state.alive = false;
        ws.ping();
      }
    }
  }, HEARTBEAT_MS);
  const rechecks = setInterval(() => {
    for (const ws of clients) recheck(ws);
  }, RECHECK_MS);
  heartbeat.unref();
  rechecks.unref();

  return function close() {
    clearInterval(heartbeat);
    clearInterval(rechecks);
    for (const ws of clients) ws.terminate();
    clients.clear();
    wss.close();
  };
}
