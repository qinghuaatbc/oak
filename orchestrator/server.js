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

const instances = new Map(); // id -> { driverInstance, manifest, driverId, recentEvents }
const wsClients = new Set();

function broadcast(msg) {
  const json = JSON.stringify(msg);
  for (const client of wsClients) client.send(json);
}

function addInstance(id, inst) {
  const driverDir = path.join(DRIVERS_DIR, inst.driver);
  const manifest = JSON.parse(fs.readFileSync(path.join(driverDir, "manifest.json"), "utf8"));
  const driverInstance = loadDriver(driverDir, { connection: inst.connection, settings: inst.settings || {} });
  const entry = { driverInstance, manifest, driverId: inst.driver, recentEvents: [] };

  driverInstance.on("event", (ev) => {
    entry.recentEvents.push({ ...ev, t: Date.now() });
    if (entry.recentEvents.length > MAX_RECENT_EVENTS) entry.recentEvents.shift();
    broadcast({ type: "event", instanceId: id, event: ev });
  });
  driverInstance.on("state", (s) => broadcast({ type: "state", instanceId: id, state: s }));
  driverInstance.on("error", (e) => console.error(`[${id}] error in ${e.where}:`, e.error.message));

  instances.set(id, entry);
  driverInstance.start();
  console.log(`Started instance "${id}" (${inst.driver})`);
  return entry;
}

for (const inst of config.instances) addInstance(inst.id, inst);

function removeInstance(id) {
  const entry = instances.get(id);
  if (!entry) return false;
  if (entry.driverInstance.connection) entry.driverInstance.connection.close();
  instances.delete(id);
  return true;
}

// Round-trips through the live instances map (not a separately-tracked
// "pending edits" list) so config.json always reflects exactly what's
// actually running, including anything added/removed since the process
// started - single source of truth, no drift possible between the two.
function persistConfig() {
  const data = {
    instances: [...instances.entries()].map(([id, entry]) => ({
      id,
      driver: entry.driverId,
      connection: entry.driverInstance.config.connection,
      settings: entry.driverInstance.config.settings,
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
      driver: entry.driverId,
      displayName: entry.manifest.displayName,
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

  const entry = instances.get(parts[2]);
  if (!entry) return sendJson(res, 404, { error: "No such instance" });

  if (parts[3] === "manifest" && req.method === "GET") {
    return sendJson(res, 200, entry.manifest);
  }

  if (parts[3] === "state" && req.method === "GET") {
    return sendJson(res, 200, entry.driverInstance.getAllState());
  }

  if (parts[3] === "events" && req.method === "GET") {
    return sendJson(res, 200, entry.recentEvents);
  }

  if (parts[3] === "action" && parts[4] && req.method === "POST") {
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
    ws.send(JSON.stringify({ type: "instance", instanceId: id, state: entry.driverInstance.getAllState() }));
  }

  ws.on("close", () => wsClients.delete(ws));
  ws.on("error", () => wsClients.delete(ws));
});

server.listen(PORT, () => console.log(`Oak orchestrator listening on :${PORT}`));
