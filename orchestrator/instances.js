"use strict";
// The configured driver instances: one Entry per instance in config.json,
// and everything that adds, starts, stops, edits, removes or saves them, plus
// the /api/instances/... and /api/health routes.
//
// Every driver event is also re-emitted on `driverEvents` as
// ("event", instanceId, eventId), so automations.js can react to it without
// this module having to know about automations at all.
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const { loadDriver, EVENTS } = require("../runtime/loader");
const { broadcast } = require("./broadcast");
const { sendJson, readJsonBody } = require("./http-util");

const CONFIG_PATH = process.env.OAK_CONFIG || path.join(__dirname, "config.json");
const DRIVERS_DIR = path.join(__dirname, "..", "drivers");
const MAX_RECENT_EVENTS = 50;
const SERVER_START = Date.now();
const driverEvents = new EventEmitter();

// One configured instance. `spec` is the source of truth for persistence
// and survives a stop (driverInstance is null while stopped) - this is what
// makes stop/start/edit possible without losing config, the same "spec
// outlives the running instance" split QTI's own instanceSpecs/instances
// pairing uses.
class Entry {
  /**
   * @param {{driver: string, connection: object, settings?: object, label?: string}} spec
   * @param {object} manifest the driver's manifest.json
   */
  constructor(spec, manifest) {
    this.spec = spec;
    this.manifest = manifest;
    /** @type {import("../runtime/loader").DriverInstance | null} null while stopped */
    this.driverInstance = null;
    this.running = false;
    /** @type {Array<{id: string, params?: object, t: number}>} the last MAX_RECENT_EVENTS */
    this.recentEvents = [];
    /** @type {object} the state when it was last stopped */
    this.lastState = {};
    /** @type {string | null} "where: message" of the latest driver error */
    this.lastError = null;
  }
}

/** @type {Map<string, Entry>} instance id -> Entry */
const instances = new Map();

function wireInstanceEvents(id, entry) {
  entry.driverInstance.on(EVENTS.EVENT, (ev) => {
    entry.recentEvents.push({ ...ev, t: Date.now() });
    if (entry.recentEvents.length > MAX_RECENT_EVENTS) entry.recentEvents.shift();
    broadcast({ type: "event", instanceId: id, event: ev });
    driverEvents.emit("event", id, ev.id);
  });
  entry.driverInstance.on(EVENTS.STATE, (s) => broadcast({ type: "state", instanceId: id, state: s }));
  entry.driverInstance.on(EVENTS.ERROR, (e) => {
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
  // spec.driver is joined onto DRIVERS_DIR below and the result is loaded
  // and executed - a value like "../../somewhere" would run code from
  // outside the drivers folder. Same character set uploadDriver() allows.
  if (typeof spec.driver !== "string" || !/^[A-Za-z0-9_-]+$/.test(spec.driver)) {
    throw new Error(`Invalid driver id "${spec.driver}"`);
  }
  const driverDir = path.join(DRIVERS_DIR, spec.driver);
  const manifest = JSON.parse(fs.readFileSync(path.join(driverDir, "manifest.json"), "utf8"));
  const entry = new Entry(spec, manifest);
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

/** GET /api/health */
function healthRoute(req, res, parts) {
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
  res.writeHead(404);
  res.end("Not found");
}

/** /api/instances and /api/instances/:id/... */
async function routes(req, res, parts) {
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
}

module.exports = {
  CONFIG_PATH, DRIVERS_DIR, Entry, instances, driverEvents,
  addInstance, stopInstance, startExistingInstance, removeInstance, editInstance, persistConfig, readInstanceState,
  routes, healthRoute,
};
