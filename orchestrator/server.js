"use strict";
// Oak orchestrator v0: loads a set of driver instances from a config file
// and exposes them over a small REST API. This is an MVP starting point,
// not a port of any existing orchestration server's design - no
// multi-tenant/customer model, no WebSocket push yet (events are read via
// polling GET /api/instances/:id/events, a natural first thing to upgrade
// to a real push transport later).
//
// Required environment variables:
//   PORT        - defaults to 8090
//   OAK_CONFIG  - path to a config.json (see config.example.json). Defaults
//                 to config.json next to this file.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { loadDriver } = require("../runtime/loader");

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

for (const inst of config.instances) {
  const driverDir = path.join(DRIVERS_DIR, inst.driver);
  const manifest = JSON.parse(fs.readFileSync(path.join(driverDir, "manifest.json"), "utf8"));
  const driverInstance = loadDriver(driverDir, { connection: inst.connection, settings: inst.settings || {} });
  const entry = { driverInstance, manifest, driverId: inst.driver, recentEvents: [] };

  driverInstance.on("event", (ev) => {
    entry.recentEvents.push({ ...ev, t: Date.now() });
    if (entry.recentEvents.length > MAX_RECENT_EVENTS) entry.recentEvents.shift();
  });
  driverInstance.on("error", (e) => {
    console.error(`[${inst.id}] error in ${e.where}:`, e.error.message);
  });

  instances.set(inst.id, entry);
  driverInstance.start();
  console.log(`Started instance "${inst.id}" (${inst.driver})`);
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

  if (parts[0] !== "api" || parts[1] !== "instances") {
    if (req.method === "GET") return serveStatic(req, res);
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

server.listen(PORT, () => console.log(`Oak orchestrator listening on :${PORT}`));
