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
const AUTOMATIONS_PATH = process.env.OAK_AUTOMATIONS || path.join(__dirname, "automations.json");
const SETTINGS_PATH = process.env.OAK_SETTINGS || path.join(__dirname, "settings.json");
const CAMERAS_PATH = process.env.OAK_CAMERAS || path.join(__dirname, "cameras.json");
const MODELS_DIR = process.env.OAK_MODELS_DIR || path.join(__dirname, "models");
const IMAGES_DIR = process.env.OAK_IMAGES_DIR || path.join(__dirname, "images");
const DRIVERS_DIR = path.join(__dirname, "..", "drivers");
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_RECENT_EVENTS = 50;
const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".glb": "model/gltf-binary",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml",
};

if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`Config not found at ${CONFIG_PATH} - copy config.example.json to config.json (or set OAK_CONFIG) first.`);
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
if (!fs.existsSync(MODELS_DIR)) fs.mkdirSync(MODELS_DIR, { recursive: true });
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });
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

// A macro step is one of:
//   {type:"action", instanceId, actionId, params}                  - call a function
//   {type:"condition", conditions:[...], then:[...], else:[...]}   - branch (recursive)
//   {type:"delay", ms}                                             - pause the sequence
// A macro can also carry its own `trigger`/`conditions` (same shapes an
// automation uses below) so it can fire itself on an event/time, not just
// run on demand - ported from QTI's own macros, which support this too.
let macros = loadJsonArray(MACROS_PATH); // [{id, name, steps, trigger?, conditions?}]
// An automation is "when this event fires (or at this time of day), do
// that" - trigger and action instance are independent, so an automation
// can bridge two entirely different drivers. `action` is either
// {kind:"action", instanceId, actionId, params} (call one function) or
// {kind:"macro", macroId} (run a whole macro step sequence). `conditions`
// (if present) gate the action: ALL must hold or the automation is
// skipped for that trigger firing. `trigger` is
// {type:"event", instanceId, eventId} or
// {type:"time", time:"HH:MM", mode:"fixed"|"sunrise"|"sunset", offsetMin, days:[0-6]}
// - ported from QTI's own automations (server.js's executeAutomationAction/
// checkTimeAutomations), adapted from QTI's sysvar/export vocabulary to
// Oak's own state/action vocabulary.
let automations = loadJsonArray(AUTOMATIONS_PATH); // [{id, name, trigger, conditions, action}]
let settings = fs.existsSync(SETTINGS_PATH) ? JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")) : {}; // {latitude, longitude} - only used for sunrise/sunset triggers
function saveSettings() {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}
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
    runEventAutomations(id, ev.id);
    runEventMacros(id, ev.id);
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

// Reads one instance's current state for an automation/macro condition
// check - `entry.lastState` is the last known snapshot for a STOPPED
// instance (captured in stopInstance() below), `getAllState()` is live for
// a running one. Returns undefined if the instance doesn't exist or has
// never reported that key, treated by evalCondition as "the condition
// can't be satisfied" rather than an error - a stopped/misconfigured
// instance is a normal, non-exceptional state to be evaluated against.
function readInstanceState(instanceId, stateId, suffix) {
  const entry = instances.get(instanceId);
  if (!entry) return undefined;
  const state = entry.running ? entry.driverInstance.getAllState() : entry.lastState;
  if (!state) return undefined;
  const key = suffix ? `${stateId}#${suffix}` : stateId;
  return state[key];
}
// Numeric comparison whenever both sides parse as numbers (so ">"/"<"
// work on level/percentage-style states); otherwise falls back to string
// equality (==/!= only - >/< on non-numeric values has no sensible
// ordering, so it's always false). Ported directly from QTI's own
// evalCondition, just reading Oak's state shape instead of a sysvar.
function evalCondition(cond) {
  const actual = readInstanceState(cond.instanceId, cond.stateId, cond.stateSuffix);
  const expected = cond.value;
  const an = Number(actual);
  const en = Number(expected);
  const bothNumeric = actual !== undefined && actual !== "" && expected !== "" && !isNaN(an) && !isNaN(en);
  switch (cond.op) {
    case "==": return bothNumeric ? an === en : String(actual) === String(expected);
    case "!=": return bothNumeric ? an !== en : String(actual) !== String(expected);
    case ">": return bothNumeric && an > en;
    case "<": return bothNumeric && an < en;
    case ">=": return bothNumeric && an >= en;
    case "<=": return bothNumeric && an <= en;
    default: return false;
  }
}
// AND semantics: an empty/missing condition list always passes.
function evalConditions(conditions) {
  if (!conditions || !conditions.length) return true;
  return conditions.every(evalCondition);
}

// Sequential, best-effort execution (ported from QTI's runMacroSteps): a
// failing step is logged and the macro moves on, rather than aborting the
// whole sequence over one bad step - QTI reached the same conclusion for
// the same reason (one misconfigured light shouldn't block the other nine
// steps in a "goodnight" macro). Recursive for "condition" steps (a step
// can branch into its own then/else step lists) - depth-capped the same
// way QTI's own version is, since a macro step list can technically
// reference itself as a branch target and loop forever otherwise.
async function runMacroSteps(steps, macroName, depth, logPrefix) {
  logPrefix = logPrefix || "macro";
  if (!steps || !steps.length) return;
  if (depth > 20) {
    console.error(`[${logPrefix} error] "${macroName}": step nesting too deep, aborting`);
    return;
  }
  for (const step of steps) {
    if (!step || !step.type) continue;
    if (step.type === "action") {
      if (!step.instanceId || !step.actionId) continue;
      const entry = instances.get(step.instanceId);
      if (!entry || !entry.running) {
        console.error(`[${logPrefix} "${macroName}"] skipped step: instance "${step.instanceId}" not running`);
        continue;
      }
      try {
        entry.driverInstance.action(step.actionId, step.params || {});
      } catch (err) {
        console.error(`[${logPrefix} error] "${macroName}":`, err.message);
      }
    } else if (step.type === "condition") {
      const branch = evalConditions(step.conditions) ? step.then : step.else;
      await runMacroSteps(branch, macroName, depth + 1, logPrefix);
    } else if (step.type === "delay") {
      const ms = Math.max(0, Math.min(3600000, Number(step.ms) || 0)); // 1hr cap - a typo'd extra zero shouldn't hang a macro run indefinitely
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
  }
}
function runMacro(macro) {
  if (!evalConditions(macro.conditions)) {
    console.log(`[macro] "${macro.name}" skipped (condition not met)`);
    return;
  }
  runMacroSteps(macro.steps || [], macro.name, 0).catch((e) => console.error(`[macro error] "${macro.name}":`, e.message));
}
function runEventMacros(instanceId, eventId) {
  for (const macro of macros) {
    if (!macro.trigger || macro.trigger.type !== "event") continue;
    if (macro.trigger.instanceId !== instanceId || macro.trigger.eventId !== eventId) continue;
    runMacro(macro);
  }
}

// Automations: single-action version of a macro, gated by trigger+
// conditions - see the `automations` declaration above for the full
// shape. Action is either one direct call or a whole macro run, ported
// from QTI's executeAutomationAction.
function executeAutomationAction(auto) {
  if (!auto.action) return;
  if (!evalConditions(auto.conditions)) {
    console.log(`[automation] "${auto.name}" skipped (condition not met)`);
    return;
  }
  if (auto.action.kind === "macro") {
    const macro = macros.find((m) => m.id === auto.action.macroId);
    if (!macro) {
      console.error(`[automation error] "${auto.name}": no such macro`);
      return;
    }
    console.log(`[automation] "${auto.name}" fired (running macro "${macro.name}")`);
    runMacro(macro);
    return;
  }
  if (!auto.action.instanceId || !auto.action.actionId) return;
  const entry = instances.get(auto.action.instanceId);
  if (!entry || !entry.running) {
    console.error(`[automation error] "${auto.name}": instance "${auto.action.instanceId}" not running`);
    return;
  }
  try {
    entry.driverInstance.action(auto.action.actionId, auto.action.params || {});
    console.log(`[automation] "${auto.name}" fired`);
  } catch (e) {
    console.error(`[automation error] "${auto.name}":`, e.message);
  }
}
function runEventAutomations(instanceId, eventId) {
  for (const auto of automations) {
    if (!auto.trigger || auto.trigger.type !== "event") continue;
    if (auto.trigger.instanceId !== instanceId || auto.trigger.eventId !== eventId) continue;
    executeAutomationAction(auto);
  }
}

// Approximate sunrise/sunset (NOAA's widely-used simplified solar
// calculator, ported directly from QTI's own computeSunTimes - accurate to
// within a few minutes, more than sufficient for a "turn the porch light
// on around sunset" automation). No network call, no dependency - pure
// trig off latitude/longitude + day-of-year. Returns "HH:MM" in local
// time, or null if the sun doesn't rise/set that day at this latitude
// (polar day/night - cosH out of [-1,1] range).
function computeSunTimes(date, lat, lon) {
  const rad = Math.PI / 180;
  const dayOfYear = Math.floor((date - new Date(date.getFullYear(), 0, 0)) / 86400000);
  const zenith = 90.833; // official sunrise/sunset zenith, includes atmospheric refraction

  function calc(isSunrise) {
    const lngHour = lon / 15;
    const t = dayOfYear + ((isSunrise ? 6 : 18) - lngHour) / 24;
    const M = 0.9856 * t - 3.289;
    let L = M + 1.916 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 282.634;
    L = ((L % 360) + 360) % 360;
    let RA = Math.atan(0.91764 * Math.tan(L * rad)) / rad;
    RA = ((RA % 360) + 360) % 360;
    const Lquadrant = Math.floor(L / 90) * 90;
    const RAquadrant = Math.floor(RA / 90) * 90;
    RA = (RA + (Lquadrant - RAquadrant)) / 15;
    const sinDec = 0.39782 * Math.sin(L * rad);
    const cosDec = Math.cos(Math.asin(sinDec));
    const cosH = (Math.cos(zenith * rad) - sinDec * Math.sin(lat * rad)) / (cosDec * Math.cos(lat * rad));
    if (cosH > 1 || cosH < -1) return null;
    let H = isSunrise ? 360 - Math.acos(cosH) / rad : Math.acos(cosH) / rad;
    H /= 15;
    const T = H + RA - 0.06571 * t - 6.622;
    return (((T - lngHour) % 24) + 24) % 24; // UT decimal hours
  }

  // `new Date(utcMs)` already IS the correct instant - .getHours()/
  // .getMinutes() automatically render it in the system's local timezone,
  // no manual offset arithmetic needed.
  function utToLocalHHMM(ut) {
    if (ut === null) return null;
    const utcMs = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) + ut * 3600000;
    const local = new Date(utcMs);
    return String(local.getHours()).padStart(2, "0") + ":" + String(local.getMinutes()).padStart(2, "0");
  }
  return { sunrise: utToLocalHHMM(calc(true)), sunset: utToLocalHHMM(calc(false)) };
}
// Recomputed once per calendar day (not once per checkTimeAutomations
// tick, which runs every 20s) - sunrise/sunset don't meaningfully move
// within a day, so there's no reason to redo the trig on every tick.
let sunTimesCache = null; // { dateKey, sunrise, sunset }
function getSunTimesToday() {
  const now = new Date();
  const dateKey = now.toISOString().slice(0, 10);
  if (sunTimesCache && sunTimesCache.dateKey === dateKey) return sunTimesCache;
  const lat = Number(settings.latitude);
  const lon = Number(settings.longitude);
  sunTimesCache = isFinite(lat) && isFinite(lon) ? { dateKey, ...computeSunTimes(now, lat, lon) } : { dateKey, sunrise: null, sunset: null };
  return sunTimesCache;
}
// A trigger with no `mode` (or mode:"fixed") uses its literal `time`
// field. mode "sunrise"/"sunset" resolves to today's solar time (null if
// latitude/longitude aren't set) plus an optional +/- minute offset
// ("30 min after sunset", etc).
function resolveTriggerTime(trigger) {
  if (!trigger.mode || trigger.mode === "fixed") return trigger.time;
  const sun = getSunTimesToday();
  const base = trigger.mode === "sunrise" ? sun.sunrise : sun.sunset;
  if (!base) return null;
  const offset = Number(trigger.offsetMin) || 0;
  if (!offset) return base;
  const parts = base.split(":");
  const total = (((Number(parts[0]) * 60 + Number(parts[1]) + offset) % 1440) + 1440) % 1440;
  return String(Math.floor(total / 60)).padStart(2, "0") + ":" + String(total % 60).padStart(2, "0");
}
// `days` (0=Sunday..6=Saturday) is optional - a MISSING `days` field means
// "every day". An explicitly empty array is NOT treated as "every day" -
// the UI always sends the checked days, so `[]` means every box got
// unchecked and the trigger should never fire, not silently fire daily.
function triggerMatchesToday(trigger, now) {
  return !Array.isArray(trigger.days) || trigger.days.includes(now.getDay());
}
// Time-of-day trigger ("at 18:00 every day, turn on the porch light") -
// checked periodically rather than one setTimeout per automation/macro, so
// editing one never has to reschedule anything; a minute-granularity
// de-dupe guard (lastFiredMinute) stops it firing more than once per
// matching minute even though this runs more often than once a minute.
const lastFiredMinute = new Map(); // automation.id -> "YYYY-MM-DDTHH:MM" it last fired at
const lastFiredMinuteMacro = new Map(); // macro.id -> "YYYY-MM-DDTHH:MM" it last fired at
function checkTimeAutomations() {
  const now = new Date();
  const nowHHMM = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
  const nowKey = now.toISOString().slice(0, 10) + "T" + nowHHMM;
  for (const auto of automations) {
    if (!auto.trigger || auto.trigger.type !== "time") continue;
    if (!triggerMatchesToday(auto.trigger, now)) continue;
    if (resolveTriggerTime(auto.trigger) !== nowHHMM) continue;
    if (lastFiredMinute.get(auto.id) === nowKey) continue;
    lastFiredMinute.set(auto.id, nowKey);
    executeAutomationAction(auto);
  }
  for (const macro of macros) {
    if (!macro.trigger || macro.trigger.type !== "time") continue;
    if (!triggerMatchesToday(macro.trigger, now)) continue;
    if (resolveTriggerTime(macro.trigger) !== nowHHMM) continue;
    if (lastFiredMinuteMacro.get(macro.id) === nowKey) continue;
    lastFiredMinuteMacro.set(macro.id, nowKey);
    runMacro(macro);
  }
}
const timeAutomationTimer = setInterval(checkTimeAutomations, 20000);
if (timeAutomationTimer.unref) timeAutomationTimer.unref();

for (const inst of config.instances)
  addInstance(inst.id, { driver: inst.driver, connection: inst.connection, settings: inst.settings, label: inst.label });

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
// running driver. Dashboard presentation (which category a slot lives in,
// which function is on/off/level) lives entirely in bindings.json now,
// not on the instance spec. `label` is one exception, kept on the
// instance itself rather than in bindings.json - it identifies WHICH
// PHYSICAL DEVICE this instance is (matching QTI's own generic, driver-
// independent "Label (optional, to tell instances apart)" field, e.g.
// telling two eisy instances apart) rather than how it's presented on a
// Dashboard slot, so it belongs with the instance, not a binding.
//
// A `type: "keyvalue"` setting (deviceNames, zoneNames, ...) is the other
// exception: the driver itself never reads it, it exists purely so the
// admin UI can show friendly names instead of raw addresses - so it's
// safe to edit live too, unlike a real connection/settings change. This
// specifically unblocks the discoverNodes -> "import into deviceNames"
// flow, which is only possible WHILE the instance is running (you need a
// live connection to discover anything) - requiring a stop first would
// make that flow impossible, not just inconvenient. Only allowed while
// running when EVERY key in updates.settings is keyvalue-typed on the
// driver's own manifest; a settings update that also touches a normal
// field still requires stopping first, same as before.
function editInstance(id, updates) {
  const entry = instances.get(id);
  if (!entry) return { error: "No such instance" };
  if (updates.label !== undefined) {
    entry.spec.label = updates.label ? String(updates.label).slice(0, 80) : undefined;
  }
  if (updates.connection) {
    if (entry.running) return { error: "Stop the instance before editing its connection" };
    entry.spec.connection = { ...entry.spec.connection, ...updates.connection };
  }
  if (updates.settings) {
    const keyvalueKeys = new Set((entry.manifest.settings || []).filter((s) => s.type === "keyvalue").map((s) => s.key));
    const onlyKeyvalue = Object.keys(updates.settings).every((k) => keyvalueKeys.has(k));
    if (entry.running && !onlyKeyvalue) return { error: "Stop the instance before editing its settings" };
    entry.spec.settings = { ...entry.spec.settings, ...updates.settings };
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
      label: entry.spec.label,
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
// 3D mesh-binding animation vocabulary - matches QTI's own create3DViewer
// exactly (QTI is this project's own prior work, not RTI's, so this is
// reusing an already-proven design rather than approximating one): a mesh
// either just highlights on click ("light"/glow), breathes continuously
// while on ("pulse", for speakers/media), or moves along one axis
// ("rotate"/"slide"/"roller" - swinging door, sliding door/window,
// roller shutter). Only the axis types need an axis+direction.
const ANIM_TYPES = ["", "light", "pulse", "rotate", "slide", "roller"];
const AXIS_ANIM_TYPES = new Set(["rotate", "slide", "roller"]);
function bindingsDefaults() {
  const obj = {};
  for (const c of BINDING_CATEGORIES) obj[c] = [];
  obj.glbs = [];
  obj.pages = [];
  return obj;
}
function loadBindings() {
  if (!fs.existsSync(BINDINGS_PATH)) return bindingsDefaults();
  try {
    const raw = JSON.parse(fs.readFileSync(BINDINGS_PATH, "utf8"));
    const out = bindingsDefaults();
    for (const c of BINDING_CATEGORIES) if (Array.isArray(raw[c])) out[c] = raw[c];
    if (Array.isArray(raw.glbs)) out.glbs = raw.glbs;
    if (Array.isArray(raw.pages)) out.pages = raw.pages;
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
// A function ref is either {kind:"action", instanceId, actionId} or
// {kind:"macro", macroId} - On/Off get both kinds (a macro has no live
// value, but on/off don't need one), Level is action-only (pass
// allowMacro=false) since a macro can't receive the live drag value a
// ring widget sends.
function sanitizeFn(f, allowMacro) {
  if (!f || typeof f !== "object") return undefined;
  if (allowMacro && f.kind === "macro") {
    return typeof f.macroId === "string" && f.macroId ? { kind: "macro", macroId: f.macroId } : undefined;
  }
  if (typeof f.instanceId === "string" && typeof f.actionId === "string") {
    return { kind: "action", instanceId: f.instanceId, actionId: f.actionId };
  }
  return undefined;
}
function sanitizeStateRef(s) {
  if (!s || typeof s !== "object") return undefined;
  return typeof s.instanceId === "string" && typeof s.stateId === "string" ? { instanceId: s.instanceId, stateId: s.stateId } : undefined;
}
function sanitizeSlot(s) {
  if (!s || typeof s !== "object") return null;
  return {
    id: typeof s.id === "string" && s.id ? s.id : crypto.randomBytes(4).toString("hex"),
    name: typeof s.name === "string" ? s.name.slice(0, 60) : "Untitled",
    onFn: sanitizeFn(s.onFn, true),
    offFn: sanitizeFn(s.offFn, true),
    levelFn: sanitizeFn(s.levelFn, false),
    onState: sanitizeStateRef(s.onState),
    levelState: sanitizeStateRef(s.levelState),
    fixedArgs: s.fixedArgs && typeof s.fixedArgs === "object" ? s.fixedArgs : {},
    stateSuffix: typeof s.stateSuffix === "string" && s.stateSuffix ? s.stateSuffix : undefined,
  };
}
// A mesh binding is a POINTER into bindings[cat], not a copy of a slot -
// {cat:"light", id:"7c61707f"} looks up the same slot the Dashboard tab
// already renders, so a 3D scene's device wiring (on/off/level functions,
// state refs, fixedArgs) has exactly one source of truth. This mirrors
// QTI's own {kind, id} mesh-binding shape (server.js's meshBindings), just
// with Oak's actual category vocabulary in place of QTI's fixed
// lights/media/doors/security set.
function sanitizeMeshBinding(m) {
  if (!m || typeof m !== "object") return undefined;
  if (!BINDING_CATEGORIES.includes(m.cat) || typeof m.id !== "string" || !m.id) return undefined;
  const out = { cat: m.cat, id: m.id, animType: ANIM_TYPES.includes(m.animType) ? m.animType : "" };
  if (AXIS_ANIM_TYPES.has(out.animType)) {
    out.axis = ["x", "y", "z"].includes(m.axis) ? m.axis : "x";
    out.dir = m.dir === -1 ? -1 : 1;
  }
  return out;
}
function sanitizeGlbScene(s) {
  if (!s || typeof s !== "object") return null;
  const meshBindings = {};
  if (s.meshBindings && typeof s.meshBindings === "object") {
    for (const [meshName, mb] of Object.entries(s.meshBindings)) {
      const sm = sanitizeMeshBinding(mb);
      if (sm) meshBindings[meshName] = sm;
    }
  }
  return {
    id: typeof s.id === "string" && s.id ? s.id : crypto.randomBytes(4).toString("hex"),
    name: typeof s.name === "string" && s.name ? s.name.slice(0, 60) : "Untitled",
    url: typeof s.url === "string" && s.url ? s.url : null,
    meshBindings,
  };
}
// Layout: a custom drag-drop dashboard page, ported from QTI's own
// live-custom.js/app.js feature (QTI is this project's own prior work,
// not RTI's - reusing an already-proven design). A page is
// {id, name, background, widgets[]} on a 12-column grid (x/y/w/h are grid
// cell indices, not pixels, so the same coordinates place a widget
// identically in the admin editor and the live renderer regardless of
// either one's actual pixel row height). Unlike QTI - which stores a
// separate lights/media/doors/keypads/security/imageButtons/cameras/
// macros array per binding category and needs one widget TYPE per array -
// Oak's Dashboard is already unified around one generic "slot" shape per
// category (see BINDING_CATEGORIES/sanitizeSlot above), so a single
// "slot" widget type with a {cat, slotId} pointer covers every device
// category at once; only camera and macro (Oak's other two non-category
// top-level entities) get their own widget types.
const LAYOUT_WIDGET_TYPES = new Set(["slot", "camera", "macro", "pageLink", "appUrl", "label", "varDisplay"]);
function sanitizeWidget(w) {
  if (!w || typeof w !== "object" || !LAYOUT_WIDGET_TYPES.has(w.type)) return null;
  const out = {
    id: typeof w.id === "string" && w.id ? w.id : crypto.randomBytes(4).toString("hex"),
    type: w.type,
    x: Math.max(0, Math.min(11, Math.round(Number(w.x)) || 0)),
    y: Math.max(0, Math.round(Number(w.y)) || 0),
    w: Math.max(1, Math.min(12, Math.round(Number(w.w)) || 2)),
    h: Math.max(1, Math.round(Number(w.h)) || 2),
    locked: Boolean(w.locked),
  };
  if (Number.isFinite(Number(w.z))) out.z = Number(w.z);
  if (w.type === "slot") {
    // A pointer into bindings[cat] by slot id, not a copy - same
    // {cat, id}-style reasoning as a 3D mesh binding (see
    // sanitizeMeshBinding above): editing a slot's name/function on the
    // Dashboard tab is automatically reflected on every page it's placed
    // on, with no separate sync step.
    if (!BINDING_CATEGORIES.includes(w.cat) || typeof w.slotId !== "string" || !w.slotId) return null;
    out.cat = w.cat;
    out.slotId = w.slotId;
    if (w.showLevel !== undefined) out.showLevel = Boolean(w.showLevel);
  } else if (w.type === "camera") {
    if (typeof w.cameraId !== "string" || !w.cameraId) return null;
    out.cameraId = w.cameraId;
  } else if (w.type === "macro") {
    if (typeof w.macroId !== "string" || !w.macroId) return null;
    out.macroId = w.macroId;
  } else if (w.type === "pageLink") {
    out.label = typeof w.label === "string" ? w.label.slice(0, 60) : "Link";
    if (typeof w.targetPageId !== "string" || !w.targetPageId) return null;
    out.targetPageId = w.targetPageId;
  } else if (w.type === "appUrl") {
    out.label = typeof w.label === "string" ? w.label.slice(0, 60) : "Link";
    if (typeof w.url !== "string" || !w.url) return null;
    out.url = w.url.slice(0, 500);
    out.openInNewTab = Boolean(w.openInNewTab);
  } else if (w.type === "label") {
    out.text = typeof w.text === "string" ? w.text.slice(0, 200) : "";
  } else if (w.type === "varDisplay") {
    out.label = typeof w.label === "string" ? w.label.slice(0, 60) : "Value";
    if (typeof w.instanceId !== "string" || !w.instanceId || typeof w.stateId !== "string" || !w.stateId) return null;
    out.instanceId = w.instanceId;
    out.stateId = w.stateId;
    if (typeof w.stateSuffix === "string" && w.stateSuffix) out.stateSuffix = w.stateSuffix;
  }
  return out;
}
function sanitizePage(p) {
  if (!p || typeof p !== "object") return null;
  const widgets = Array.isArray(p.widgets) ? p.widgets.map(sanitizeWidget).filter(Boolean) : [];
  return {
    id: typeof p.id === "string" && p.id ? p.id : crypto.randomBytes(4).toString("hex"),
    name: typeof p.name === "string" && p.name ? p.name.slice(0, 60) : "Untitled",
    background: p.background && typeof p.background.url === "string" ? { url: p.background.url } : null,
    widgets,
  };
}
function sanitizeBindings(raw) {
  const out = bindingsDefaults();
  if (!raw || typeof raw !== "object") return out;
  for (const c of BINDING_CATEGORIES) {
    if (!Array.isArray(raw[c])) continue;
    out[c] = raw[c].map(sanitizeSlot).filter(Boolean);
  }
  out.glbs = Array.isArray(raw.glbs) ? raw.glbs.map(sanitizeGlbScene).filter(Boolean) : [];
  out.pages = Array.isArray(raw.pages) ? raw.pages.map(sanitizePage).filter(Boolean) : [];
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
// A `perInstance` state (see SPEC.md) is ALWAYS reported suffixed
// ("<stateId>#<instanceKey>"), even for a driver with only one relay/
// zone/partition - http-relay's driver.js calls
// ctx.setState("relay.on", value, "0") unconditionally, there's no bare
// "relay.on" key to fall back to. A default (un-zoned) auto-generated
// slot needs SOME suffix to ever read that state back, so this peeks at
// the instance's actual live state (only possible while it's running) to
// find one - if there's exactly one distinct suffix in use for that
// state id, that's an unambiguous, safe guess; if there are several
// (a real multi-zone device already reporting more than one), guessing
// would silently pick the wrong one, so this deliberately backs off and
// leaves stateSuffix unset - same "don't guess when it's genuinely
// ambiguous" call roleActionsForCategory makes for climate.
function detectSingleSuffix(entry, stateId) {
  if (!stateId || !entry.running || !entry.driverInstance) return undefined;
  const state = entry.driverInstance.getAllState();
  if (stateId in state) return undefined; // bare key exists - no suffix needed at all
  const prefix = `${stateId}#`;
  const suffixes = new Set();
  for (const key of Object.keys(state)) {
    if (key.startsWith(prefix)) suffixes.add(key.slice(prefix.length));
  }
  return suffixes.size === 1 ? [...suffixes][0] : undefined;
}
function autoGenerateBindings() {
  let added = 0;
  for (const [id, entry] of instances) {
    const manifest = entry.manifest;
    const cats = Array.isArray(manifest.category) ? manifest.category : [manifest.category || "generic"];
    for (const cat of cats) {
      if (!BINDING_CATEGORIES.includes(cat)) continue;
      // "Already has a default for this instance" means an un-zoned slot
      // whose On/Off/Level (whichever are action-kind) point at this
      // instance - a macro-bound function has no instanceId of its own,
      // so it never counts toward this check either way.
      const hasDefault = bindings[cat].some(
        (s) =>
          (!s.fixedArgs || Object.keys(s.fixedArgs).length === 0) &&
          [s.onFn, s.offFn, s.levelFn].some((f) => f && f.kind === "action" && f.instanceId === id)
      );
      if (hasDefault) continue;
      const { onAction, offAction, levelAction } = roleActionsForCategory(manifest, cat);
      if (!onAction && !offAction && !levelAction) continue;
      const { onState, levelState } = roleStatesForCategory(manifest, cat);
      const stateSuffix = detectSingleSuffix(entry, onState && onState.id) || detectSingleSuffix(entry, levelState && levelState.id);
      bindings[cat].push({
        id: crypto.randomBytes(4).toString("hex"),
        name: manifest.displayName,
        onFn: onAction ? { kind: "action", instanceId: id, actionId: onAction.id } : undefined,
        offFn: offAction ? { kind: "action", instanceId: id, actionId: offAction.id } : undefined,
        levelFn: levelAction ? { instanceId: id, actionId: levelAction.id } : undefined,
        onState: onState ? { instanceId: id, stateId: onState.id } : undefined,
        levelState: levelState ? { instanceId: id, stateId: levelState.id } : undefined,
        fixedArgs: {},
        stateSuffix,
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
const BUILTIN_DRIVERS = new Set([
  "dsc-powerseries", "http-relay", "mqtt-plug", "generic-dimmer", "zone-hub", "eisy", "homeassistant",
  "pushover", "philips-hue", "sonos", "telegram", "slack", "openweathermap",
]);

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
  } else if (reqPath.startsWith("/images/")) {
    baseDir = IMAGES_DIR;
    reqPath = reqPath.slice("/images".length);
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
    // Explicit Content-Length (not left to Node to infer) - without it,
    // this response comes back chunked with no declared size, so the
    // browser's fetch/XHR progress events report lengthComputable:false
    // for a .glb load and the admin/live 3D loading bar can only ever
    // show an indeterminate stripe, never a real percentage.
    res.writeHead(200, { "Content-Type": type, "Content-Length": data.length });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  // url.pathname keeps percent-encoding intact (Node's URL parser doesn't
  // decode it) - an instance/driver/camera/macro id containing a space or
  // other URL-special character (e.g. an id typed straight from a
  // driver's display name, like "Generic dimmer" instead of a slug) never
  // matches its actual stored key without this, breaking every route
  // that references it by path segment (stop/start/delete/manifest/state/
  // config/action) with a silent 404 - the instance shows up in listings
  // but nothing about it can be controlled.
  const parts = decodeURIComponent(url.pathname).split("/").filter(Boolean);

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
      // trigger/conditions are optional (a macro that only ever runs on
      // demand, e.g. from the Dashboard's On/Off function picker, has
      // neither) - passed through as-is, same permissive validation
      // runMacroSteps already applies at execution time (an invalid step
      // is skipped, not rejected up front).
      const macro = {
        id: body.id || `macro-${Date.now()}`,
        name: body.name,
        steps: body.steps,
        trigger: body.trigger || undefined,
        conditions: Array.isArray(body.conditions) ? body.conditions : undefined,
      };
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

  if (parts[1] === "automations" && parts.length === 2 && req.method === "GET") {
    return sendJson(res, 200, automations);
  }
  if (parts[1] === "automations" && parts.length === 2 && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      if (!body.name || !body.trigger || !body.action) {
        return sendJson(res, 400, { error: "name, trigger, and action are required" });
      }
      const auto = {
        id: body.id || `auto-${Date.now()}`,
        name: body.name,
        trigger: body.trigger,
        conditions: Array.isArray(body.conditions) ? body.conditions : undefined,
        action: body.action,
      };
      const existingIdx = automations.findIndex((a) => a.id === auto.id);
      if (existingIdx === -1) automations.push(auto);
      else automations[existingIdx] = auto;
      saveJsonArray(AUTOMATIONS_PATH, automations);
      broadcast({ type: "automationsChanged" });
      return sendJson(res, 200, { ok: true, id: auto.id });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }
  if (parts[1] === "automations" && parts.length === 3 && req.method === "DELETE") {
    automations = automations.filter((a) => a.id !== parts[2]);
    saveJsonArray(AUTOMATIONS_PATH, automations);
    broadcast({ type: "automationsChanged" });
    return sendJson(res, 200, { ok: true });
  }
  if (parts[1] === "automations" && parts.length === 4 && parts[3] === "run" && req.method === "POST") {
    const auto = automations.find((a) => a.id === parts[2]);
    if (!auto) return sendJson(res, 404, { error: "No such automation" });
    executeAutomationAction(auto); // manual test-fire, bypassing the trigger (conditions still apply)
    return sendJson(res, 200, { ok: true });
  }

  if (parts[1] === "settings" && parts.length === 2 && req.method === "GET") {
    return sendJson(res, 200, settings);
  }
  if (parts[1] === "settings" && parts.length === 2 && req.method === "PUT") {
    try {
      const body = await readJsonBody(req);
      settings = {
        latitude: body.latitude !== undefined && body.latitude !== "" ? Number(body.latitude) : undefined,
        longitude: body.longitude !== undefined && body.longitude !== "" ? Number(body.longitude) : undefined,
      };
      saveSettings();
      sunTimesCache = null; // latitude/longitude changed - today's cached sun times are now stale
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
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

  // Generic image upload (Layout page backgrounds) - deliberately a
  // separate endpoint/directory from glb-upload above rather than reused:
  // that route force-renames anything uploaded through it to end in
  // ".glb" and serves it as model/gltf-binary, which would mislabel a
  // real JPEG/PNG background image.
  const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg"]);
  if (parts[1] === "image-upload" && parts.length === 2 && req.method === "POST") {
    try {
      const { filename, dataBase64 } = await readJsonBody(req);
      if (!dataBase64) throw new Error("No file data received");
      const fileBuf = Buffer.from(dataBase64, "base64");
      const safeName = (filename || "image.png").replace(/[^A-Za-z0-9 _.-]/g, "").trim() || "image.png";
      const ext = path.extname(safeName).toLowerCase();
      const finalName = IMAGE_EXTS.has(ext) ? safeName : `${safeName}.png`;
      fs.writeFileSync(path.join(IMAGES_DIR, finalName), fileBuf);
      return sendJson(res, 200, { ok: true, url: `/images/${finalName}` });
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
      label: entry.spec.label,
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
      // The id becomes a URL path segment for every stop/start/delete/
      // action/config/state route this instance ever gets - a space or
      // other URL-special character here (easy to end up with if someone
      // pastes a driver's display name instead of typing a short slug)
      // makes the instance impossible to control afterward, since the
      // browser's encoded URL never matches this raw stored key. Caught
      // here instead of a decodeURIComponent-and-hope-it-matches dance
      // on every route.
      if (!/^[A-Za-z0-9_-]+$/.test(body.id)) {
        return sendJson(res, 400, { error: "Instance id must be letters, numbers, hyphens, or underscores only (no spaces) - e.g. \"living_room_light\"" });
      }
      if (instances.has(body.id)) return sendJson(res, 400, { error: `Instance "${body.id}" already exists` });
      addInstance(body.id, { driver: body.driver, connection: body.connection || {}, settings: body.settings || {}, label: body.label });
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
      label: entry.spec.label,
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
