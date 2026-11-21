// Real-time channel of the page on screen (WebSocket, /ws). The server only
// says that something changed, who is looking at a board and which card
// somebody is dragging; the data itself is always read through the API.
//
// A page follows either one board (openBoardChannel) or whole projects
// (followProjects: matrix, badges, blocked tasks). The channel reconnects by
// itself. While it is down the page is read again every few seconds instead,
// so a network that blocks WebSockets only makes the updates slower.
import { clientId } from './api.js';

const CLOSE_SIGNED_OUT = 4401;
const CLOSE_DENIED = 4403;
const POLL_MS = 15 * 1000;
const MAX_RETRY_MS = 30 * 1000;
const nothing = () => {};

let active = null;

// Anything else on screen that wants to hear about changes, whichever page
// opened the channel (the task dialog). Returns the function that stops it.
const listeners = new Set();
export function onNotice(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Only one page is on screen at a time.
export function closeChannel() {
  if (active) active.close();
  active = null;
}

// Draws the current page again, through the router.
export const rerenderPage = () => window.dispatchEvent(new Event('hashchange'));

// hello: the message that says what to follow. handlers: onChange(message),
// onPeople(people), onDrag({ user, task_id, status }), onDragEnd(userId),
// onOffline(), onDenied()
function open(hello, given) {
  closeChannel();
  const handlers = { onChange: nothing, onPeople: nothing, onDrag: nothing, onDragEnd: nothing, onOffline: nothing, onDenied: nothing, ...given };
  const url = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;
  let socket = null;
  let closed = false;
  let following = false;
  let wasFollowing = false;
  let retries = 0;
  let retryTimer = null;

  function changed(message) {
    handlers.onChange(message);
    for (const listener of listeners) listener(message);
  }

  function onMessage(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === 'subscribed' || message.type === 'watching') {
      retries = 0;
      following = true;
      if (message.type === 'subscribed') {
        handlers.onPeople(message.people);
        for (const drag of message.drags) handlers.onDrag(drag);
      }
      // Whatever happened while the channel was down was missed.
      if (wasFollowing) changed({});
      wasFollowing = true;
    } else if (message.type === 'board_changed' || message.type === 'project_changed') {
      // This tab has already redrawn its own changes.
      if (message.origin !== clientId) changed(message);
    } else if (message.type === 'presence') handlers.onPeople(message.people);
    else if (message.type === 'drag') handlers.onDrag(message);
    else if (message.type === 'drag_end') handlers.onDragEnd(message.user_id);
    else if (message.type === 'denied') {
      channel.close();
      handlers.onDenied();
    }
  }

  function connect() {
    if (closed) return;
    try {
      socket = new WebSocket(url);
    } catch {
      return;
    }
    socket.addEventListener('open', () => socket.send(JSON.stringify(hello)));
    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', (event) => {
      following = false;
      if (closed) return;
      handlers.onOffline();
      if (event.code === CLOSE_SIGNED_OUT) {
        window.location.reload();
        return;
      }
      if (event.code === CLOSE_DENIED) {
        channel.close();
        handlers.onDenied();
        return;
      }
      retryTimer = setTimeout(connect, Math.min(MAX_RETRY_MS, 1000 * 2 ** retries));
      retries += 1;
    });
  }

  const poll = setInterval(() => {
    if (!following && !document.hidden) changed({});
  }, POLL_MS);

  const channel = {
    send(message) {
      if (following && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    },
    close() {
      closed = true;
      clearInterval(poll);
      clearTimeout(retryTimer);
      if (socket) socket.close();
    },
  };
  active = channel;
  connect();
  return channel;
}

export const openBoardChannel = (groupId, handlers) => open({ type: 'subscribe', group_id: groupId }, handlers);

// Keeps a page that shows whole projects up to date: `reload` runs (a moment
// after the last notice, so a burst of changes costs one read) whenever
// something changes in any of them. `el` is the page's own element: nothing
// is opened unless it really reached the screen, and nothing runs once it left.
//
// A notice says what kind of change it was (`kind`: status, people, comment,
// links, project). None of the pages that follow whole projects show comments
// or a group's links, so those are not read again for them.
const UNSEEN_KINDS = new Set(['comment', 'links']);
export function followProjects(el, projectIds, reload) {
  let timer = null;
  const onChange = (notice) => {
    if (UNSEEN_KINDS.has(notice.kind)) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!el.isConnected) return;
      try {
        await reload();
      } catch (err) {
        // No longer theirs to see: the router shows what is left.
        if (err.status === 403 || err.status === 404) rerenderPage();
      }
    }, 300);
  };
  setTimeout(() => {
    if (el.isConnected && projectIds.length > 0) open({ type: 'watch', project_ids: projectIds }, { onChange, onDenied: rerenderPage });
  }, 0);
}
