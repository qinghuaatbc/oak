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
//
// This file only starts things and routes requests; the work is in:
//   instances.js    driver instances (add/start/stop/edit/remove), /api/instances, /api/health
//   automations.js  macros, automations, sunrise/sunset, /api/macros, /api/automations, /api/settings
//   bindings.js     Dashboard slots, 3D scenes, Layout pages, /api/bindings
//   cameras.js      cameras and ffmpeg, /api/cameras
//   drivers.js      driver packages, /api/drivers
//   files.js        static files and uploads, /api/glb, /api/glb-upload, /api/image-upload
//   comm.js         calls, chat and push between live.html sessions (over /ws)
//   broadcast.js    the /ws clients and broadcast()
//   auth.js         login and sessions
const http = require("http");
const fs = require("fs");
const auth = require("./auth");
const { isWebSocketUpgrade, acceptUpgrade } = require("./ws-lite");
const instances = require("./instances");
const automations = require("./automations");
const bindings = require("./bindings");
const cameras = require("./cameras");
const drivers = require("./drivers");
const files = require("./files");
const { handleWsRequest, commDisconnect } = require("./comm");
const { wsClients } = require("./broadcast");
const { sendJson, readJsonBody } = require("./http-util");
const { CONFIG_PATH, addInstance } = instances;

// A driver's own code runs on real timers/sockets - an async rejection
// inside one (e.g. an unawaited promise in an onData/onConnect handler)
// happens outside any try/catch and, since Node 15, kills the whole
// process by default if nothing is listening for it. DriverInstance's own
// per-callback _guarded() only catches *synchronous* throws, so this
// process-level net is still needed on top of it - the same conclusion
// QTI's own server.js reached (see its handleFatalDriverError comment).
process.on("uncaughtException", (err) => console.error("[FATAL - uncaught]", (err && err.stack) || err));
process.on("unhandledRejection", (err) => console.error("[FATAL - unhandled rejection]", (err instanceof Error && err.stack) || err));

const PORT = parseInt(process.env.PORT || "8090", 10);

if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`Config not found at ${CONFIG_PATH} - copy config.example.json to config.json (or set OAK_CONFIG) first.`);
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

// One bad instance (a missing host/port after a manual config edit, a
// renamed/removed driver, a broken driver.js) must never take the WHOLE
// orchestrator down at boot - every other saved instance would go dark
// with it. The POST /api/instances route already gets this for free (its
// handler wraps addInstance in try/catch and returns a 400), but nothing
// wrapped this startup loop the same way - found via a synchronous
// net.createConnection throw (missing host/port) propagating all the way
// up through addInstance to here, uncaught, killing the process before
// it ever started listening.
for (const inst of config.instances) {
  try {
    addInstance(inst.id, { driver: inst.driver, connection: inst.connection, settings: inst.settings, label: inst.label });
  } catch (err) {
    console.error(`Failed to start instance "${inst.id}" (${inst.driver}) at boot:`, err.message);
  }
}

// /api/<first part> -> the module that handles it. Each handler answers
// every request it is given, with a plain 404 for one it doesn't know.
const API_ROUTES = {
  drivers: drivers.routes,
  health: instances.healthRoute,
  instances: instances.routes,
  macros: automations.routes,
  automations: automations.routes,
  settings: automations.routes,
  cameras: cameras.routes,
  bindings: bindings.routes,
  glb: files.routes,
  "glb-upload": files.routes,
  "image-upload": files.routes,
};

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

  // Session gate - replaces Caddy's basic_auth (disabled on the live VPS
  // since 2026-08-14 over an iOS PWA bug basic_auth itself couldn't be
  // fixed around - see auth.js's own header comment for the full story).
  // /login.html and /api/login are the only paths reachable without a
  // session. WebSocket upgrades (/ws, /camera-ws) never reach this
  // callback - the server.on("upgrade", ...) listener below applies the
  // same session check itself.
  if (!auth.isPublicPath(url.pathname) && !auth.hasValidSession(req)) {
    if (parts[0] === "api") return sendJson(res, 401, { error: "Not signed in" });
    if (req.method === "GET") {
      // (Relative, so it works behind a proxy that serves Oak under a path too.)
      const up = "../".repeat(Math.max(0, url.pathname.split("/").length - 2));
      res.writeHead(302, { Location: `${up}login.html?next=${encodeURIComponent(url.pathname.slice(1) + url.search)}` });
      return res.end();
    }
    res.writeHead(401);
    return res.end("Not signed in");
  }

  if (parts[0] === "api" && parts[1] === "login" && parts.length === 2 && req.method === "POST") {
    return auth.handleLogin(req, res, readJsonBody, sendJson);
  }
  if (parts[0] === "api" && parts[1] === "logout" && parts.length === 2 && req.method === "POST") {
    return auth.handleLogout(req, res, sendJson);
  }

  if (parts[0] !== "api") {
    if (req.method === "GET") return files.serveStatic(req, res);
    res.writeHead(404);
    return res.end("Not found");
  }

  const route = Object.hasOwn(API_ROUTES, parts[1]) ? API_ROUTES[parts[1]] : null;
  if (route) return route(req, res, parts);
  res.writeHead(404);
  return res.end("Not found");
});

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url, "http://localhost");
  if (!isWebSocketUpgrade(req)) {
    socket.destroy();
    return;
  }

  // Same session gate as the HTTP routes. Both /ws (live state of every
  // instance, comm signaling) and /camera-ws (hands a caller-chosen URL to
  // ffmpeg) were previously open to anyone who could reach the port. The
  // browser sends the oak_session cookie on the upgrade request itself, so
  // every page that opens these sockets (already behind login) keeps working.
  if (!auth.hasValidSession(req)) {
    socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return;
  }

  if (url.pathname === "/camera-ws") {
    const rtspUrl = url.searchParams.get("url");
    if (!rtspUrl) {
      socket.destroy();
      return;
    }
    const ws = acceptUpgrade(req, socket);
    cameras.startCameraFfmpeg(rtspUrl, ws);
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
  for (const [id, entry] of instances.instances) {
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

// Gated on require.main so this file can be require()'d by a test (to reach
// the pure sanitize* functions below) without also binding a real socket -
// `node server.js` (how this actually runs in production/the LaunchAgent)
// still starts the server exactly as before, since require.main === module
// is true in that case; only an external require() skips it.
if (require.main === module) {
  server.listen(PORT, () => console.log(`Oak orchestrator listening on :${PORT}`));
}

// Exported for orchestrator/test/*.test.js - the pure validation functions
// (from bindings.js) and the http.Server itself (not listening - see the
// require.main guard above; a test calls .listen(0, ...) itself).
const { sanitizeWidget, sanitizePage, sanitizeMeshBinding, sanitizeGlbScene, sanitizeLayoutBackground } = bindings;
module.exports = { sanitizeWidget, sanitizePage, sanitizeMeshBinding, sanitizeGlbScene, sanitizeLayoutBackground, server };
