"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// --- Comm: 1:1 WebRTC video/voice calling + text chat between live.html
// sessions, plus Web Push to wake a backgrounded device - ported directly
// from QTI's server.js (commUsers/commDevices Maps, commSignal relay,
// commChatMessage broadcast/direct, commLogMissedCall, push triggers on
// an incoming offer or a message to someone offline).
const push = require("./push");
const commUsers = new Map(); // clientId (per-WS-session) -> {clientId, deviceId, displayName, ws}
const commDevices = new Map(); // deviceId (persistent, survives disconnect) -> {deviceId, displayName, clientId, lastSeen}
const COMM_CHAT_MAX = 200;
const COMM_CHAT_FILE = path.join(__dirname, "comm_chat.json");
const COMM_FALLBACK_ICE = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }];

function commLoadChatHistory() {
  try {
    return JSON.parse(fs.readFileSync(COMM_CHAT_FILE, "utf8"));
  } catch (e) {
    return [];
  }
}
function commSaveChatHistory() {
  try {
    fs.writeFileSync(COMM_CHAT_FILE, JSON.stringify(commChatHistory));
  } catch (e) {
    /* best-effort */
  }
}
let commChatHistory = commLoadChatHistory();

function commUserList() {
  return [...commUsers.values()].map((u) => ({ clientId: u.clientId, displayName: u.displayName }));
}
function commBroadcastUsers() {
  const json = JSON.stringify({ type: "commUsers", users: commUserList() });
  for (const u of commUsers.values()) {
    try {
      u.ws.send(json);
    } catch (e) {
      /* client gone, cleaned up on its own close event */
    }
  }
}
function commDisconnect(ws) {
  if (!ws.commClientId) return;
  const user = commUsers.get(ws.commClientId);
  commUsers.delete(ws.commClientId);
  ws.commClientId = null;
  if (user && user.deviceId && commDevices.has(user.deviceId)) {
    const d = commDevices.get(user.deviceId);
    d.clientId = null;
    d.lastSeen = Date.now();
  }
  commBroadcastUsers();
}
// A logged-in clientId's own deviceId if it has one, else `id` itself if
// it's already a bare deviceId (the offline-device registry case) - lets
// callers reach a device by whichever id they happen to have.
function commResolveDeviceId(id) {
  const user = commUsers.get(id);
  if (user && user.deviceId) return user.deviceId;
  if (commDevices.has(id)) return id;
  return null;
}
function commBroadcastChat(msg) {
  commChatHistory.push(msg);
  if (commChatHistory.length > COMM_CHAT_MAX) commChatHistory.splice(0, commChatHistory.length - COMM_CHAT_MAX);
  commSaveChatHistory();
  const json = JSON.stringify(msg);
  for (const u of commUsers.values()) {
    try {
      u.ws.send(json);
    } catch (e) {
      /* client gone */
    }
  }
}
// A call that ends without ever reaching "connected" - logs as a system
// chat message so it's visible next time either side opens the panel,
// like a real phone's call log, rather than silently vanishing.
function commLogMissedCall(callerClientId, calleeClientId, reason) {
  const caller = commUsers.get(callerClientId);
  const callee = commUsers.get(calleeClientId);
  const callerName = caller ? caller.displayName : "Someone";
  const calleeName = callee ? callee.displayName : "someone";
  const reasonText = reason === "busy" ? "busy" : reason === "decline" ? "declined" : "no answer";
  commBroadcastChat({
    from: callerClientId,
    fromName: callerName,
    to: null,
    text: `📞 Missed call: ${callerName} → ${calleeName} (${reasonText})`,
    timestamp: Date.now(),
    system: true,
  });
}

function handleWsRequest(ws, msg) {
  const requestId = msg.requestId;
  function reply(ok, fields) {
    try {
      ws.send(JSON.stringify({ type: "result", requestId, ok, ...fields }));
    } catch (e) {
      /* client gone */
    }
  }

  if (msg.type === "commRegister") {
    // Reuse the clientId this socket already registered (a rename, or the
    // reconnect-driven re-register) rather than minting a new one every
    // time - otherwise the old entry never leaves commUsers, leaving a
    // permanent "ghost" duplicate of the same device in everyone's list.
    const clientId = ws.commClientId || crypto.randomUUID();
    ws.commClientId = clientId;
    const displayName = String(msg.displayName || "Guest").slice(0, 40);
    const deviceId = msg.deviceId ? String(msg.deviceId).slice(0, 80) : null;
    commUsers.set(clientId, { clientId, deviceId, displayName, ws });
    if (deviceId) commDevices.set(deviceId, { deviceId, displayName, clientId, lastSeen: Date.now() });
    commBroadcastUsers();
    return reply(true, { clientId });
  }

  if (msg.type === "commGetVapidKey") {
    return reply(true, { key: push.getPublicKey() });
  }
  if (msg.type === "commPushSubscribe") {
    if (!msg.deviceId || !msg.endpoint || !msg.keys) return reply(false, { error: "deviceId, endpoint, and keys are required" });
    push.subscribe(String(msg.deviceId).slice(0, 80), msg.endpoint, msg.keys);
    return reply(true, {});
  }
  if (msg.type === "commPushUnsubscribe") {
    if (msg.deviceId) push.unsubscribe(String(msg.deviceId).slice(0, 80));
    return reply(true, {});
  }

  if (msg.type === "commSignal") {
    if (!ws.commClientId) return reply(false, { error: "Not registered" });
    const sender = commUsers.get(ws.commClientId);
    const target = commUsers.get(msg.to);
    if (target) {
      try {
        target.ws.send(JSON.stringify({ type: "commSignal", from: ws.commClientId, signalType: msg.signalType, payload: msg.payload }));
      } catch (e) {
        /* peer gone */
      }
    }
    // Wake a backgrounded/locked callee for an incoming offer - fires
    // regardless of whether `target` above was found live, since the
    // whole point is reaching a device with no open WS connection right
    // now (commResolveDeviceId falls back to the persistent registry).
    if (msg.signalType === "offer") {
      const deviceId = commResolveDeviceId(msg.to);
      if (deviceId) push.sendToDevice(deviceId, `📞 ${sender ? sender.displayName : "Someone"}`, "Incoming call - tap to answer", { type: "call" }).catch(() => {});
    }
    if (msg.signalType === "decline" || msg.signalType === "busy") {
      commLogMissedCall(msg.to, ws.commClientId, msg.signalType);
    } else if (msg.signalType === "timeout") {
      commLogMissedCall(ws.commClientId, msg.to, "timeout");
    }
    return reply(true, {});
  }

  if (msg.type === "commChatMessage") {
    const sender = commUsers.get(ws.commClientId);
    if (!sender) return reply(false, { error: "Not registered" });
    const entry = { from: sender.clientId, fromName: sender.displayName, to: msg.to || null, text: String(msg.text || "").slice(0, 2000), timestamp: Date.now() };
    commChatHistory.push(entry);
    if (commChatHistory.length > COMM_CHAT_MAX) commChatHistory.splice(0, commChatHistory.length - COMM_CHAT_MAX);
    commSaveChatHistory();
    const json = JSON.stringify(entry);
    if (entry.to) {
      const recipient = commUsers.get(entry.to);
      if (recipient) {
        try {
          recipient.ws.send(json);
        } catch (e) {
          /* client gone */
        }
      }
      try {
        ws.send(json);
      } catch (e) {
        /* client gone */
      }
      const deviceId = commResolveDeviceId(entry.to);
      if (deviceId) push.sendToDevice(deviceId, sender.displayName, entry.text, { type: "chat" }).catch(() => {});
    } else {
      for (const u of commUsers.values()) {
        try {
          u.ws.send(json);
        } catch (e) {
          /* client gone */
        }
      }
      for (const d of commDevices.values()) {
        if (!d.clientId) push.sendToDevice(d.deviceId, sender.displayName, entry.text, { type: "chat" }).catch(() => {});
      }
    }
    return reply(true, {});
  }

  if (msg.type === "commGetIceServers") {
    // No TURN server configured for Oak - STUN-only works for most
    // same-network/public-IP cases but won't reliably punch through every
    // NAT (double-NAT, symmetric-NAT on cellular). Same honest limitation
    // QTI's own commIceServers() documents without a TURN_HOST configured.
    return reply(true, { iceServers: COMM_FALLBACK_ICE });
  }

  if (msg.type === "commGetChatHistory") {
    return reply(true, { messages: commChatHistory });
  }

  reply(false, { error: `Unknown request type: ${msg.type}` });
}

module.exports = { handleWsRequest, commDisconnect };
