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

for (const inst of config.instances) addInstance(inst.id, { driver: inst.driver, connection: inst.connection, settings: inst.settings });

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
// running driver.
function editInstance(id, updates) {
  const entry = instances.get(id);
  if (!entry) return { error: "No such instance" };
  if (entry.running) return { error: "Stop the instance before editing its config" };
  if (updates.connection) entry.spec.connection = { ...entry.spec.connection, ...updates.connection };
  if (updates.settings) entry.spec.settings = { ...entry.spec.settings, ...updates.settings };
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

function listDriverManifests() {
  return fs
    .readdirSync(DRIVERS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => JSON.parse(fs.readFileSync(path.join(DRIVERS_DIR, d.name, "manifest.json"), "utf8")));
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
    return sendJson(res, 200, { connection: entry.spec.connection, settings: entry.spec.settings, running: entry.running });
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

  ws.on("close", () => wsClients.delete(ws));
  ws.on("error", () => wsClients.delete(ws));
});

server.listen(PORT, () => console.log(`Oak orchestrator listening on :${PORT}`));
