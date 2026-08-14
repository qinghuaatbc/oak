"use strict";
// Oak orchestrator v0: loads a set of driver instances from a config file
// and exposes them over a REST API plus a WebSocket push channel at /ws.
// Still no multi-tenant/customer model - that's a natural future step, not
// an MVP requirement.
//
// Required environment variables:
//   PORT        - defaults to 8090
//   OAK_CONFIG  - path to a config.json (see config.example.json). Defaults
//                 to config.json next to this file.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { loadDriver } = require("../runtime/loader");
const { isWebSocketUpgrade, acceptUpgrade } = require("./ws-lite");

// A driver's own code runs on real timers/sockets - an async rejection
// inside one (e.g. an unawaited promise in an onData/onConnect handler)
// happens outside any try/catch and, since Node 15, kills the whole
// process by default if nothing is listening for it. DriverInstance's own
// per-callback _guarded() only catches *synchronous* throws, so this
// process-level net is still needed on top of it - the same conclusion
// QTI's own server.js reached (see its handleFatalDriverError comment).
process.on("uncaughtException", (err) => console.error("[FATAL - uncaught]", (err && err.stack) || err));
process.on("unhandledRejection", (err) => console.error("[FATAL - unhandled rejection]", (err && err.stack) || err));

const PORT = parseInt(process.env.PORT || "8090", 10);
const CONFIG_PATH = process.env.OAK_CONFIG || path.join(__dirname, "config.json");
const MACROS_PATH = process.env.OAK_MACROS || path.join(__dirname, "macros.json");
const CAMERAS_PATH = process.env.OAK_CAMERAS || path.join(__dirname, "cameras.json");
const MODELS_DIR = process.env.OAK_MODELS_DIR || path.join(__dirname, "models");
const DRIVERS_DIR = path.join(__dirname, "..", "drivers");
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_RECENT_EVENTS = 50;
const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".glb": "model/gltf-binary",
};

if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`Config not found at ${CONFIG_PATH} - copy config.example.json to config.json (or set OAK_CONFIG) first.`);
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
if (!fs.existsSync(MODELS_DIR)) fs.mkdirSync(MODELS_DIR, { recursive: true });
const SERVER_START = Date.now();

function loadJsonArray(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    console.error(`Failed to read ${filePath}:`, e.message);
    return [];
  }
}
function saveJsonArray(filePath, arr) {
  fs.writeFileSync(filePath, JSON.stringify(arr, null, 2));
}

let macros = loadJsonArray(MACROS_PATH); // [{id, name, steps:[{instanceId,actionId,params}]}]
let cameras = loadJsonArray(CAMERAS_PATH); // [{id, name, rtspUrl}]

// id -> { spec: {driver,connection,settings}, manifest, driverInstance,
// running, recentEvents, lastState }. `spec` is the source of truth for
// persistence and survives a stop (driverInstance is null while stopped) -
// this is what makes stop/start/edit possible without losing config, the
// same "spec outlives the running instance" split QTI's own
// instanceSpecs/instances pairing uses.
const instances = new Map();
const wsClients = new Set();

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

function broadcast(msg) {
  const json = JSON.stringify(msg);
  for (const client of wsClients) client.send(json);
}

function wireInstanceEvents(id, entry) {
  entry.driverInstance.on("event", (ev) => {
    entry.recentEvents.push({ ...ev, t: Date.now() });
    if (entry.recentEvents.length > MAX_RECENT_EVENTS) entry.recentEvents.shift();
    broadcast({ type: "event", instanceId: id, event: ev });
  });
  entry.driverInstance.on("state", (s) => broadcast({ type: "state", instanceId: id, state: s }));
  entry.driverInstance.on("error", (e) => {
    entry.lastError = `${e.where}: ${e.error.message}`;
    console.error(`[${id}] error in ${e.where}:`, e.error.message);
  });
}

function startRuntime(id, entry) {
  const driverDir = path.join(DRIVERS_DIR, entry.spec.driver);
  entry.driverInstance = loadDriver(driverDir, { connection: entry.spec.connection, settings: entry.spec.settings || {} });
  wireInstanceEvents(id, entry);
  entry.driverInstance.start();
  entry.running = true;
  console.log(`Started instance "${id}" (${entry.spec.driver})`);
}

function addInstance(id, spec) {
  const driverDir = path.join(DRIVERS_DIR, spec.driver);
  const manifest = JSON.parse(fs.readFileSync(path.join(driverDir, "manifest.json"), "utf8"));
  const entry = { spec, manifest, driverInstance: null, running: false, recentEvents: [], lastState: {}, lastError: null };
  instances.set(id, entry);
  startRuntime(id, entry);
  return entry;
}

// Sequential, best-effort execution (ported from QTI's runMacroSteps): a
// failing step is logged and the macro moves on, rather than aborting the
// whole sequence over one bad step - QTI reached the same conclusion for
// the same reason (one misconfigured light shouldn't block the other nine
// steps in a "goodnight" macro).
async function runMacro(macro) {
  for (const step of macro.steps) {
    const entry = instances.get(step.instanceId);
    if (!entry || !entry.running) {
      console.error(`[macro "${macro.name}"] skipped step: instance "${step.instanceId}" not running`);
      continue;
    }
    try {
      entry.driverInstance.action(step.actionId, step.params || {});
    } catch (err) {
      console.error(`[macro "${macro.name}"] step failed:`, err.message);
    }
  }
}

for (const inst of config.instances)
  addInstance(inst.id, { driver: inst.driver, connection: inst.connection, settings: inst.settings });

function stopInstance(id) {
  const entry = instances.get(id);
  if (!entry || !entry.running) return false;
  entry.lastState = entry.driverInstance.getAllState();
  entry.driverInstance.stop();
  entry.driverInstance = null;
  entry.running = false;
  return true;
}

function startExistingInstance(id) {
  const entry = instances.get(id);
  if (!entry || entry.running) return false;
  startRuntime(id, entry);
  return true;
}

function removeInstance(id) {
  const entry = instances.get(id);
  if (!entry) return false;
  if (entry.running) entry.driverInstance.stop();
  instances.delete(id);
  return true;
}

// Editing a live connection's config out from under it isn't safe (e.g. a
// TCP socket already open to the OLD host/port) - requiring stop-first
// keeps this simple and correct instead of trying to hot-reconfigure a
// running driver. Dashboard presentation (name, category, which function
// is on/off/level) lives entirely in bindings.json now, not on the
// instance spec - see loadBindings/saveBindings/autoGenerateBindings below.
function editInstance(id, updates) {
  const entry = instances.get(id);
  if (!entry) return { error: "No such instance" };
  if (updates.connection || updates.settings) {
    if (entry.running) return { error: "Stop the instance before editing its connection/settings" };
    if (updates.connection) entry.spec.connection = { ...entry.spec.connection, ...updates.connection };
    if (updates.settings) entry.spec.settings = { ...entry.spec.settings, ...updates.settings };
  }
  return { ok: true };
}

// Round-trips through the live instances map (not a separately-tracked
// "pending edits" list) so config.json always reflects exactly what's
// actually configured, running or not - single source of truth, no drift
// possible between the two.
function persistConfig() {
  const data = {
    instances: [...instances.entries()].map(([id, entry]) => ({
      id,
      driver: entry.spec.driver,
      connection: entry.spec.connection,
      settings: entry.spec.settings,
    })),
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2));
}

// --- Dashboard bindings: QTI's own model, ported directly rather than
// Oak's earlier (now removed) 1-card-per-instance approach. A binding
// "slot" is NOT the same thing as a driver instance - one hub-style
// instance (e.g. a multi-zone controller) can back many slots, each
// naming a specific zone/device and picking which of that instance's
// exported actions is its on/off/level function, with fixedArgs merged
// into every call (e.g. {zone:"kitchen"}) - this is what lets "kitchen
// light" and "living room light" both be slots against the SAME instance.
// Grouped by category so the Dashboard/Live UI can render one section per
// category the same way QTI's admin does (Lights, Switches, ...).
const BINDINGS_PATH = process.env.OAK_BINDINGS || path.join(__dirname, "bindings.json");
const BINDING_CATEGORIES = ["light", "switch", "climate", "security", "media", "sensor", "generic"];
function bindingsDefaults() {
  const obj = {};
  for (const c of BINDING_CATEGORIES) obj[c] = [];
  return obj;
}
function loadBindings() {
  if (!fs.existsSync(BINDINGS_PATH)) return bindingsDefaults();
  try {
    const raw = JSON.parse(fs.readFileSync(BINDINGS_PATH, "utf8"));
    const out = bindingsDefaults();
    for (const c of BINDING_CATEGORIES) if (Array.isArray(raw[c])) out[c] = raw[c];
    return out;
  } catch (e) {
    console.error(`Failed to read ${BINDINGS_PATH}:`, e.message);
    return bindingsDefaults();
  }
}
let bindings = loadBindings();
function saveBindings() {
  fs.writeFileSync(BINDINGS_PATH, JSON.stringify(bindings, null, 2));
}

// Sanitizes a client-submitted bindings object the same defensive,
// field-by-field way QTI's own saveBindings handler does (server.js:
// 1802-1821 in QTI) rather than trusting the body shape wholesale.
function sanitizeSlot(s) {
  if (!s || typeof s !== "object") return null;
  const slot = {
    id: typeof s.id === "string" && s.id ? s.id : crypto.randomBytes(4).toString("hex"),
    name: typeof s.name === "string" ? s.name.slice(0, 60) : "Untitled",
    instanceId: typeof s.instanceId === "string" ? s.instanceId : undefined,
    onActionId: typeof s.onActionId === "string" ? s.onActionId : undefined,
    offActionId: typeof s.offActionId === "string" ? s.offActionId : undefined,
    levelActionId: typeof s.levelActionId === "string" ? s.levelActionId : undefined,
    onStateId: typeof s.onStateId === "string" ? s.onStateId : undefined,
    levelStateId: typeof s.levelStateId === "string" ? s.levelStateId : undefined,
    fixedArgs: s.fixedArgs && typeof s.fixedArgs === "object" ? s.fixedArgs : {},
    stateSuffix: typeof s.stateSuffix === "string" && s.stateSuffix ? s.stateSuffix : undefined,
  };
  return slot;
}
function sanitizeBindings(raw) {
  const out = bindingsDefaults();
  if (!raw || typeof raw !== "object") return out;
  for (const c of BINDING_CATEGORIES) {
    if (!Array.isArray(raw[c])) continue;
    out[c] = raw[c].map(sanitizeSlot).filter(Boolean);
  }
  return out;
}

// Explicit, opt-in convenience (a button in the UI), not a silent side
// effect of adding an instance - QTI reached the same conclusion for its
// own "binding templates" feature. Idempotent: running it twice in a row
// adds nothing new, since it skips any category where the instance
// already has an un-zoned (fixedArgs-less) default slot.
// Role lookups are scoped per category, not a single manifest-wide find()
// - a hub manifest can have DIFFERENT actions plausibly matching the same
// role in different subsystems (e.g. zone-hub's lightSetLevel is role
// "level" for its light zones, but that must never get picked as the
// climate zone's target-temperature function just because both are role
// "level" scans over the same actions array). Security uses arm/disarm
// instead of on/off; climate has no settled on/off/level role vocabulary
// yet, so its default slot is left with no functions bound at all -
// skipped entirely rather than creating an empty, unusable slot - and the
// admin binds it by hand (exactly what the zone-hub example driver is
// for: proving the manual path works, not just the auto-generated one).
function roleActionsForCategory(manifest, cat) {
  if (cat === "security") {
    return { onAction: manifest.actions.find((a) => a.role === "arm"), offAction: manifest.actions.find((a) => a.role === "disarm"), levelAction: undefined };
  }
  if (cat === "climate" || cat === "sensor") {
    return { onAction: undefined, offAction: undefined, levelAction: undefined };
  }
  return {
    onAction: manifest.actions.find((a) => a.role === "on"),
    offAction: manifest.actions.find((a) => a.role === "off"),
    levelAction: manifest.actions.find((a) => a.role === "level"),
  };
}
// Mirrors roleActionsForCategory's category-scoping for STATES - a blind
// manifest-wide "find the state with role=level" has the exact same
// cross-subsystem collision problem actions have (zone-hub's light.level
// and a hypothetical climate state could both plausibly want role
// "level"), so this stays in lockstep with which category is being
// generated for rather than scanning independently.
function roleStatesForCategory(manifest, cat) {
  if (cat === "security" || cat === "climate" || cat === "sensor") {
    // No settled role vocabulary for a security/climate/sensor readout
    // state yet (arm/disarm doesn't have a simple boolean "on" state the
    // way a light does) - left unbound, same as their actions above; a
    // plain card without a level function never reads levelState anyway.
    return { onState: undefined, levelState: undefined };
  }
  return { onState: manifest.states.find((s) => s.role === "on"), levelState: manifest.states.find((s) => s.role === "level") };
}
function autoGenerateBindings() {
  let added = 0;
  for (const [id, entry] of instances) {
    const manifest = entry.manifest;
    const cats = Array.isArray(manifest.category) ? manifest.category : [manifest.category || "generic"];
    for (const cat of cats) {
      if (!BINDING_CATEGORIES.includes(cat)) continue;
      const hasDefault = bindings[cat].some((s) => s.instanceId === id && (!s.fixedArgs || Object.keys(s.fixedArgs).length === 0));
      if (hasDefault) continue;
      const { onAction, offAction, levelAction } = roleActionsForCategory(manifest, cat);
      if (!onAction && !offAction && !levelAction) continue;
      const { onState, levelState } = roleStatesForCategory(manifest, cat);
      bindings[cat].push({
        id: crypto.randomBytes(4).toString("hex"),
        name: manifest.displayName,
        instanceId: id,
        onActionId: onAction ? onAction.id : undefined,
        offActionId: offAction ? offAction.id : undefined,
        levelActionId: levelAction ? levelAction.id : undefined,
        onStateId: onState ? onState.id : undefined,
        levelStateId: levelState ? levelState.id : undefined,
        fixedArgs: {},
      });
      added++;
    }
  }
  if (added) saveBindings();
  return added;
}

// Ported directly from QTI's own server.js startCameraFfmpeg - the ffmpeg
// flags here (-g 16, -force_key_frames, -frag_duration) were arrived at
// against a real Hikvision camera: -movflags frag_keyframe ALONE only
// starts a new fragment at each keyframe, and that camera's substream only
// ever emitted ONE keyframe for the whole encode - nothing reached the
// client until ffmpeg exited. Forcing a keyframe every second plus
// time-based fragmentation independent of keyframes is what actually makes
// the stream arrive incrementally. Re-deriving this from scratch would mean
// re-discovering the same bug against real hardware; reusing the known-good
// flags is the point of "reference QTI" here.
const activeCameraProcs = new Set();
function startCameraFfmpeg(rtspUrl, ws) {
  const args = [
    "-rtsp_transport", "tcp",
    "-i", rtspUrl,
    "-an",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-tune", "zerolatency",
    "-profile:v", "high",
    "-pix_fmt", "yuv420p",
    "-g", "16",
    "-force_key_frames", "expr:gte(t,n_forced*1)",
    "-f", "mp4",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof+dash",
    "-frag_duration", "1000000",
    "-reset_timestamps", "1",
    "pipe:1",
  ];
  const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  activeCameraProcs.add(proc);

  // An unreachable/misconfigured camera doesn't necessarily make ffmpeg
  // exit - it can sit there retrying indefinitely, burning CPU. Give it
  // CONNECT_TIMEOUT_MS to produce real output before killing it.
  const CONNECT_TIMEOUT_MS = 10000;
  let gotData = false;
  const connectTimer = setTimeout(() => {
    if (gotData) return;
    try {
      ws.send(JSON.stringify({ type: "error", error: `Camera did not respond within ${CONNECT_TIMEOUT_MS / 1000}s - check the RTSP URL/credentials.` }));
    } catch (e) {
      /* client gone */
    }
    proc.kill();
  }, CONNECT_TIMEOUT_MS);

  proc.stdout.on("data", (chunk) => {
    if (!gotData) {
      gotData = true;
      clearTimeout(connectTimer);
    }
    try {
      ws.sendBinary(chunk);
    } catch (e) {
      proc.kill();
    }
  });
  let stderrTail = "";
  proc.stderr.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4000);
  });
  proc.on("exit", (code) => {
    clearTimeout(connectTimer);
    activeCameraProcs.delete(proc);
    if (code !== 0 && code !== null) {
      try {
        ws.send(JSON.stringify({ type: "error", error: `ffmpeg exited (${code}): ${stderrTail.split("\n").slice(-5).join(" ")}` }));
      } catch (e) {
        /* client gone */
      }
    }
    try {
      ws.close();
    } catch (e) {
      /* already closed */
    }
  });
  // spawn() failing outright (ffmpeg not installed) fires an 'error' event
  // on the child process - with no listener, Node treats that as an
  // uncaught exception. The process-level net at the top of this file would
  // catch it, but a reconnecting client would then repeat that indefinitely
  // - handle it here directly instead, same as QTI's own comment on this.
  proc.on("error", (err) => {
    clearTimeout(connectTimer);
    activeCameraProcs.delete(proc);
    try {
      ws.send(JSON.stringify({ type: "error", error: `Couldn't start ffmpeg: ${err.message}${err.code === "ENOENT" ? " - is ffmpeg installed on this server?" : ""}` }));
    } catch (e) {
      /* client gone */
    }
    try {
      ws.close();
    } catch (e) {
      /* already closed */
    }
  });
  ws.on("close", () => proc.kill());
  return proc;
}

// The 4 drivers shipped with Oak itself - kept undeletable through the
// upload UI (a driver folder living outside DRIVERS_DIR entirely would be
// a bigger change; blocking deletion of the ones this repo ships is the
// simple, correct guard for now).
const BUILTIN_DRIVERS = new Set(["dsc-powerseries", "http-relay", "mqtt-plug", "generic-dimmer"]);

function listDriverManifests() {
  return fs
    .readdirSync(DRIVERS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => JSON.parse(fs.readFileSync(path.join(DRIVERS_DIR, d.name, "manifest.json"), "utf8")));
}

// A driver author who didn't bother declaring `category` still gets a
// useful default instead of silently landing in "generic" (where the
// Add-Instance category filter and Dashboard's Auto-generate button would
// never surface it under Light/Switch/Security). Guessed from the SAME
// role tags roleActionsForCategory already reads elsewhere, in order of
// specificity: arm/disarm is unambiguously security; any level-capable
// on/off is called "light" (the more common case among Oak's own built-in
// drivers) rather than "media", since nothing in a manifest distinguishes
// the two without a category the author would have just declared anyway;
// on/off with no level is a plain switch. This is only ever a starting
// guess - the author's own explicit `category` always wins, and nothing
// downstream is locked to it (a slot can bind to any instance regardless
// of its driver's declared category).
function inferCategory(manifest) {
  const roles = new Set(manifest.actions.map((a) => a.role).filter(Boolean));
  if (roles.has("arm") || roles.has("disarm")) return "security";
  if (roles.has("level")) return "light";
  if (roles.has("on") || roles.has("off")) return "switch";
  return "generic";
}

// Uploaded drivers are plain text (a manifest.json + a driver.js), not a
// packaged/encrypted bundle the way an .rtidriver is - Oak has no
// packaging step at all yet, so this is the honest v1: upload the two
// files as-is. Validated only for "is this parseable as a manifest with
// the fields the runtime actually needs" - not sandboxed any more
// tightly than the drivers Oak already ships with, since every driver
// (built-in or uploaded) already runs through the same vm.Context in
// runtime/loader.js and Oak's whole model already assumes an installer
// trusts what they're adding, the same trust boundary RTI's own driver
// install flow has.
function uploadDriver(driverId, manifestJson, driverJs) {
  const safeId = String(driverId || "")
    .trim()
    .replace(/[^a-zA-Z0-9-]/g, "");
  if (!safeId) return { error: "Driver id must be alphanumeric/hyphens" };
  let manifest;
  try {
    manifest = JSON.parse(manifestJson);
  } catch (e) {
    return { error: `manifest.json isn't valid JSON: ${e.message}` };
  }
  if (!manifest.id || !manifest.displayName || !Array.isArray(manifest.actions) || !Array.isArray(manifest.states)) {
    return { error: "manifest.json must have id, displayName, actions[], states[]" };
  }
  if (!driverJs || !driverJs.trim()) return { error: "driver.js is required" };
  const hasCategory = manifest.category && (!Array.isArray(manifest.category) || manifest.category.length);
  let savedManifestJson = manifestJson;
  let inferredCategory = null;
  if (!hasCategory) {
    inferredCategory = inferCategory(manifest);
    manifest.category = inferredCategory;
    savedManifestJson = JSON.stringify(manifest, null, 2);
  }
  const dir = path.join(DRIVERS_DIR, safeId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), savedManifestJson);
  fs.writeFileSync(path.join(dir, "driver.js"), driverJs);
  return { ok: true, id: safeId, inferredCategory };
}

function deleteDriverPackage(driverId) {
  if (BUILTIN_DRIVERS.has(driverId)) return { error: "This driver ships with Oak and can't be removed here" };
  const dir = path.join(DRIVERS_DIR, driverId);
  if (!fs.existsSync(dir)) return { error: "No such driver" };
  const inUse = [...instances.values()].some((entry) => entry.spec.driver === driverId);
  if (inUse) return { error: "An instance is still using this driver - remove that instance first" };
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true };
}

function sendJson(res, status, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(req, res) {
  let reqPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  if (reqPath === "/") reqPath = "/admin.html";
  let baseDir = PUBLIC_DIR;
  if (reqPath.startsWith("/models/")) {
    baseDir = MODELS_DIR;
    reqPath = reqPath.slice("/models".length);
  }
  const filePath = path.join(baseDir, reqPath);
  if (!filePath.startsWith(baseDir)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const type = STATIC_TYPES[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);

  if (parts[0] !== "api") {
    if (req.method === "GET") return serveStatic(req, res);
    res.writeHead(404);
    return res.end("Not found");
  }

  if (parts[1] === "drivers" && parts.length === 2 && req.method === "GET") {
    return sendJson(res, 200, listDriverManifests());
  }

  if (parts[1] === "drivers" && parts.length === 2 && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const result = uploadDriver(body.driverId, body.manifestJson, body.driverJs);
      if (result.error) return sendJson(res, 400, result);
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (parts[1] === "drivers" && parts.length === 3 && req.method === "DELETE") {
    const result = deleteDriverPackage(parts[2]);
    if (result.error) return sendJson(res, 400, result);
    return sendJson(res, 200, result);
  }

  if (parts[1] === "health" && parts.length === 2 && req.method === "GET") {
    const health = [...instances.entries()].map(([id, entry]) => ({
      id,
      label: entry.manifest.displayName,
      driverKey: entry.spec.driver,
      running: entry.running,
      lastError: entry.lastError,
    }));
    return sendJson(res, 200, { uptimeMs: Date.now() - SERVER_START, health });
  }

  if (parts[1] === "macros" && parts.length === 2 && req.method === "GET") {
    return sendJson(res, 200, macros);
  }
  if (parts[1] === "macros" && parts.length === 2 && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      if (!body.name || !Array.isArray(body.steps) || !body.steps.length) {
        return sendJson(res, 400, { error: "name and at least one step are required" });
      }
      const macro = { id: body.id || `macro-${Date.now()}`, name: body.name, steps: body.steps };
      const existingIdx = macros.findIndex((m) => m.id === macro.id);
      if (existingIdx === -1) macros.push(macro);
      else macros[existingIdx] = macro;
      saveJsonArray(MACROS_PATH, macros);
      broadcast({ type: "macrosChanged" });
      return sendJson(res, 200, { ok: true, id: macro.id });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }
  if (parts[1] === "macros" && parts.length === 3 && req.method === "DELETE") {
    macros = macros.filter((m) => m.id !== parts[2]);
    saveJsonArray(MACROS_PATH, macros);
    broadcast({ type: "macrosChanged" });
    return sendJson(res, 200, { ok: true });
  }
  if (parts[1] === "macros" && parts.length === 4 && parts[3] === "run" && req.method === "POST") {
    const macro = macros.find((m) => m.id === parts[2]);
    if (!macro) return sendJson(res, 404, { error: "No such macro" });
    runMacro(macro); // fire-and-forget, like QTI's own runMacro() - the caller gets an immediate ack, not a "wait for every step" response
    return sendJson(res, 200, { ok: true });
  }

  if (parts[1] === "cameras" && parts.length === 2 && req.method === "GET") {
    return sendJson(res, 200, cameras);
  }
  if (parts[1] === "cameras" && parts.length === 2 && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      if (!body.name || !body.rtspUrl) return sendJson(res, 400, { error: "name and rtspUrl are required" });
      const camera = { id: body.id || `cam-${Date.now()}`, name: body.name, rtspUrl: body.rtspUrl };
      cameras.push(camera);
      saveJsonArray(CAMERAS_PATH, cameras);
      return sendJson(res, 200, { ok: true, id: camera.id });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }
  if (parts[1] === "cameras" && parts.length === 3 && req.method === "DELETE") {
    cameras = cameras.filter((c) => c.id !== parts[2]);
    saveJsonArray(CAMERAS_PATH, cameras);
    return sendJson(res, 200, { ok: true });
  }

  if (parts[1] === "bindings" && parts.length === 2 && req.method === "GET") {
    return sendJson(res, 200, bindings);
  }
  if (parts[1] === "bindings" && parts.length === 2 && req.method === "PUT") {
    try {
      const body = await readJsonBody(req);
      bindings = sanitizeBindings(body);
      saveBindings();
      broadcast({ type: "bindings", bindings });
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }
  if (parts[1] === "bindings" && parts.length === 3 && parts[2] === "auto-generate" && req.method === "POST") {
    const added = autoGenerateBindings();
    broadcast({ type: "bindings", bindings });
    return sendJson(res, 200, { ok: true, added });
  }

  if (parts[1] === "glb" && parts.length === 2 && req.method === "GET") {
    const files = fs.readdirSync(MODELS_DIR).filter((f) => f.toLowerCase().endsWith(".glb"));
    return sendJson(res, 200, files.map((f) => ({ name: f, url: `/models/${f}` })));
  }
  if (parts[1] === "glb-upload" && parts.length === 2 && req.method === "POST") {
    try {
      const { filename, dataBase64 } = await readJsonBody(req);
      if (!dataBase64) throw new Error("No file data received");
      const fileBuf = Buffer.from(dataBase64, "base64");
      const safeName = (filename || "model.glb").replace(/[^A-Za-z0-9 _.-]/g, "").trim() || "model.glb";
      const finalName = safeName.toLowerCase().endsWith(".glb") ? safeName : `${safeName}.glb`;
      fs.writeFileSync(path.join(MODELS_DIR, finalName), fileBuf);
      return sendJson(res, 200, { ok: true, url: `/models/${finalName}` });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (parts[1] !== "instances") {
    res.writeHead(404);
    return res.end("Not found");
  }

  if (parts.length === 2 && req.method === "GET") {
    const list = [...instances.entries()].map(([id, entry]) => ({
      id,
      driver: entry.spec.driver,
      displayName: entry.manifest.displayName,
      running: entry.running,
      category: entry.manifest.category,
      actions: entry.manifest.actions.map((a) => a.id),
      events: entry.manifest.events.map((e) => e.id),
    }));
    return sendJson(res, 200, list);
  }

  if (parts.length === 2 && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      if (!body.id || !body.driver) return sendJson(res, 400, { error: "id and driver are required" });
      if (instances.has(body.id)) return sendJson(res, 400, { error: `Instance "${body.id}" already exists` });
      addInstance(body.id, { driver: body.driver, connection: body.connection || {}, settings: body.settings || {} });
      persistConfig();
      broadcast({ type: "instanceAdded", instanceId: body.id });
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (parts.length === 3 && req.method === "DELETE") {
    const id = parts[2];
    if (!removeInstance(id)) return sendJson(res, 404, { error: "No such instance" });
    persistConfig();
    broadcast({ type: "instanceRemoved", instanceId: id });
    return sendJson(res, 200, { ok: true });
  }

  if (parts.length === 3 && req.method === "PUT") {
    try {
      const body = await readJsonBody(req);
      const result = editInstance(parts[2], body);
      if (result.error) return sendJson(res, 400, result);
      persistConfig();
      broadcast({ type: "instanceEdited", instanceId: parts[2] });
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (parts.length === 4 && parts[3] === "stop" && req.method === "POST") {
    if (!stopInstance(parts[2])) return sendJson(res, 400, { error: "Instance not running, or doesn't exist" });
    persistConfig();
    broadcast({ type: "instanceStopped", instanceId: parts[2] });
    return sendJson(res, 200, { ok: true });
  }

  if (parts.length === 4 && parts[3] === "start" && req.method === "POST") {
    if (!startExistingInstance(parts[2])) return sendJson(res, 400, { error: "Instance already running, or doesn't exist" });
    persistConfig();
    broadcast({ type: "instanceStarted", instanceId: parts[2] });
    return sendJson(res, 200, { ok: true });
  }

  const entry = instances.get(parts[2]);
  if (!entry) return sendJson(res, 404, { error: "No such instance" });

  if (parts[3] === "manifest" && req.method === "GET") {
    return sendJson(res, 200, entry.manifest);
  }

  if (parts[3] === "config" && req.method === "GET") {
    return sendJson(res, 200, {
      connection: entry.spec.connection,
      settings: entry.spec.settings,
      running: entry.running,
      category: entry.manifest.category,
    });
  }

  if (parts[3] === "state" && req.method === "GET") {
    // A stopped instance has no live driver to ask - the snapshot taken
    // right before stop() is the best available answer, not an empty {}.
    return sendJson(res, 200, entry.running ? entry.driverInstance.getAllState() : entry.lastState);
  }

  if (parts[3] === "events" && req.method === "GET") {
    return sendJson(res, 200, entry.recentEvents);
  }

  if (parts[3] === "action" && parts[4] && req.method === "POST") {
    if (!entry.running) return sendJson(res, 400, { error: "Instance is stopped" });
    try {
      const params = await readJsonBody(req);
      entry.driverInstance.action(parts[4], params);
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  res.writeHead(404);
  res.end("Not found");
});

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url, "http://localhost");
  if (!isWebSocketUpgrade(req)) {
    socket.destroy();
    return;
  }

  if (url.pathname === "/camera-ws") {
    const rtspUrl = url.searchParams.get("url");
    if (!rtspUrl) {
      socket.destroy();
      return;
    }
    const ws = acceptUpgrade(req, socket);
    startCameraFfmpeg(rtspUrl, ws);
    return;
  }

  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  const ws = acceptUpgrade(req, socket);
  wsClients.add(ws);

  // Push a snapshot immediately so a client that just (re)connected doesn't
  // have to wait for the next real change to know current state - same
  // reasoning as QTI's own /ws handshake.
  for (const [id, entry] of instances) {
    ws.send(JSON.stringify({ type: "instance", instanceId: id, state: entry.running ? entry.driverInstance.getAllState() : entry.lastState }));
  }

  ws.on("message", (text) => {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch (e) {
      return;
    }
    if (msg.requestId !== undefined) handleWsRequest(ws, msg);
  });
  ws.on("close", () => {
    wsClients.delete(ws);
    commDisconnect(ws);
  });
  ws.on("error", () => {
    wsClients.delete(ws);
    commDisconnect(ws);
  });
});

server.listen(PORT, () => console.log(`Oak orchestrator listening on :${PORT}`));
