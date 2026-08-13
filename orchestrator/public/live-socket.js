// WS client for live.js/admin.js - browser-native WebSocket, no library.
// Ported from QTI's shared.js connectWS(): request()/onPush()/onStatus(),
// same requestId-keyed pending-promise pattern - Comm (chat/calling) needs
// real request/response over the same channel the server otherwise just
// pushes state/event updates through.
export function connectWS() {
  let socket = null;
  let nextId = 1;
  const pending = new Map(); // requestId -> {resolve, reject}
  const pushListeners = new Set(); // fn(msg) - unsolicited pushes
  const statusListeners = new Set(); // fn(connected)

  function connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${proto}//${location.host}/ws`);
    socket.addEventListener("open", () => {
      for (const fn of statusListeners) fn(true);
    });
    socket.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (msg.type === "result" && msg.requestId !== undefined && pending.has(msg.requestId)) {
        const { resolve, reject } = pending.get(msg.requestId);
        pending.delete(msg.requestId);
        if (msg.ok) resolve(msg);
        else reject(new Error(msg.error || "request failed"));
        return;
      }
      for (const fn of pushListeners) fn(msg);
    });
    socket.addEventListener("close", () => {
      for (const fn of statusListeners) fn(false);
      setTimeout(connect, 2000);
    });
    socket.addEventListener("error", () => socket.close());
  }

  function request(type, fields) {
    return new Promise((resolve, reject) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        reject(new Error("Not connected"));
        return;
      }
      const requestId = String(nextId++);
      pending.set(requestId, { resolve, reject });
      socket.send(JSON.stringify({ type, requestId, ...fields }));
    });
  }

  function onPush(fn) {
    pushListeners.add(fn);
  }
  function onStatus(fn) {
    statusListeners.add(fn);
  }

  connect();
  return { request, onPush, onStatus };
}

// Kept for admin.js/live.js's existing simple "just give me every push
// message plus connect status" usage - a thin wrapper over connectWS()
// rather than a second, parallel WS connection.
export function connectLiveSocket(onMessage, onStatus) {
  const ws = connectWS();
  ws.onPush(onMessage);
  if (onStatus) ws.onStatus(onStatus);
  return ws;
}
