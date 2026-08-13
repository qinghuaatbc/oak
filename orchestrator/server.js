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
const DRIVERS_DIR = path.join(__dirname, "..", "drivers");
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_RECENT_EVENTS = 50;
const STATIC_TYPES = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`Config not found at ${CONFIG_PATH} - copy config.example.json to config.json (or set OAK_CONFIG) first.`);
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

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
  entry.driverInstance.on("error", (e) => console.error(`[${id}] error in ${e.where}:`, e.error.message));
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
  const entry = { spec, manifest, driverInstance: null, running: false, recentEvents: [], lastState: {} };
  instances.set(id, entry);
  startRuntime(id, entry);
  return entry;
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
  const filePath = path.join(PUBLIC_DIR, reqPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
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
  if (url.pathname !== "/ws" || !isWebSocketUpgrade(req)) {
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
