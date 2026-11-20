// Real-time channel of the board on screen (WebSocket, /ws). The server only
// says that the board changed, who is looking at it and which card somebody
// is dragging; the board itself is always read through the API.
//
// The channel reconnects by itself. While it is down the board is read again
// every few seconds instead, so a network that blocks WebSockets only makes
// the updates slower.
import { clientId } from './api.js';

const CLOSE_SIGNED_OUT = 4401;
const CLOSE_DENIED = 4403;
const POLL_MS = 15 * 1000;
const MAX_RETRY_MS = 30 * 1000;

let active = null;

// Only one board is on screen at a time.
export function closeBoardChannel() {
  if (active) active.close();
  active = null;
}

// handlers: onChange(message), onPeople(people), onDrag({ user, task_id, status }),
// onDragEnd(userId), onOffline(), onDenied()
export function openBoardChannel(groupId, handlers) {
  closeBoardChannel();
  const url = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;
  let socket = null;
  let closed = false;
  let subscribed = false;
  let wasSubscribed = false;
  let retries = 0;
  let retryTimer = null;

  function onMessage(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === 'subscribed') {
      retries = 0;
      subscribed = true;
      handlers.onPeople(message.people);
      for (const drag of message.drags) handlers.onDrag(drag);
      // Whatever happened while the channel was down was missed.
      if (wasSubscribed) handlers.onChange(message);
      wasSubscribed = true;
    } else if (message.type === 'board_changed') {
      // This tab has already redrawn its own changes.
      if (message.origin !== clientId) handlers.onChange(message);
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
    socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'subscribe', group_id: groupId })));
    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', (event) => {
      subscribed = false;
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
    if (!subscribed && !document.hidden) handlers.onChange({});
  }, POLL_MS);

  const channel = {
    send(message) {
      if (subscribed && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
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
