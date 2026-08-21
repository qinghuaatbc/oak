"use strict";
// Oak driver runtime: loads a manifest + driver module and wires them to a
// transport connection. Original design - see ../SPEC.md.
//
// Driver code runs inside its own vm.Context (own global object, not the
// host process's) rather than a plain require(). Two independent reasons:
//   1. Crash isolation - every callback into driver code is try/catch'd
//      and turned into an "error" event instead of an uncaught exception,
//      the same lesson this platform's own multi-tenant host learned the
//      hard way (one misbehaving driver instance must never take down
//      every other running instance in the same process).
//   2. Room to restrict what a driver can touch later (e.g. a
//      community-contributed driver you haven't fully vetted yet) without
//      redesigning the loader - the vm.Context boundary is already there.
// vm is a Node.js core module; nothing here depends on any third-party
// driver SDK's sandboxing approach.

const net = require("net");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const Module = require("module");
const { EventEmitter } = require("events");
const WsClient = require("ws");

function loadDriverModule(driverDir) {
  const filePath = path.join(driverDir, "driver.js");
  const source = fs.readFileSync(filePath, "utf8");
  const sandboxModule = { exports: {} };
  const sandbox = {
    module: sandboxModule,
    exports: sandboxModule.exports,
    require: Module.createRequire(filePath),
    console,
    fetch, // standard Web API, available as a Node global since Node 18 - not from any driver SDK
    // Node's own built-in WebSocket global (since Node 22) is spec-strict
    // and has no way to send custom request headers (Authorization, a
    // subprotocol, Origin) during the handshake, which real device APIs
    // routinely require (e.g. UDI's ISY/eisy real-time event stream needs
    // Authorization + Sec-WebSocket-Protocol: ISYSUB + a specific Origin).
    // The `ws` package's WebSocket does support a headers/protocol options
    // object, so it's what's exposed here - this is a real, load-bearing
    // dependency (like web-push), not a nice-to-have.
    WebSocket: WsClient,
    Buffer, // needed by any driver speaking a binary protocol (e.g. MQTT) - core Node global
    URLSearchParams, // standard Web API, needed by any driver POSTing a form-urlencoded body (e.g. Pushover's REST API) - not exposed in a vm.Context by default the way it is in a normal Node global scope
  };
  vm.createContext(sandbox);
  const wrapped = `(function (module, exports, require) {\n${source}\n})`;
  const compiled = vm.runInContext(wrapped, sandbox, { filename: filePath });
  compiled(sandboxModule, sandboxModule.exports, sandbox.require);
  return sandboxModule.exports;
}

// Self-healing reconnect backoff: starts at 1s, doubles on every failed
// attempt, caps at 30s - fast enough to recover quickly from a brief blip
// (a device reboot, a router hiccup) without hammering a device/network
// that's genuinely down for longer.
const RECONNECT_INITIAL_MS = 1000;
const RECONNECT_MAX_MS = 30000;

class Connection extends EventEmitter {
  // Thin wrapper over a persistent raw transport (TCP today; a
  // SerialConnection could implement the same {send,close,open} interface
  // over a serial port later without changing DriverInstance at all). Only
  // used for drivers whose manifest declares transport:"tcp" - a
  // request/response device (transport:"http") uses HttpClient instead and
  // has no persistent Connection at all.
  constructor({ host, port }) {
    super();
    this.host = host;
    this.port = port;
    this.socket = null;
    this.connected = false;
    // Before this, a dropped connection (device reboot, network blip) was
    // permanent until a human opened the admin UI and manually stopped +
    // restarted the instance - found via code review: every TCP-transport
    // driver (dsc-powerseries and honeywell-vista included) went silently
    // and indefinitely dark on any disconnect, with nothing in this class
    // or DriverInstance ever calling open() again. Fixed once here instead
    // of in every individual driver, since none of them have any way to
    // reopen this same Connection object themselves.
    this._closedByCaller = false; // true only after close() - distinguishes "told to stop" from "the wire dropped"
    this._reconnectTimer = null;
    this._reconnectDelay = RECONNECT_INITIAL_MS;
  }
  open() {
    // net.createConnection throws SYNCHRONOUSLY (before any "error" event
    // machinery even exists to catch it) when host/port are missing -
    // e.g. a saved instance whose connection config predates a manifest
    // change, or was hand-edited wrong. Every other connection failure
    // (ECONNREFUSED, DNS lookup failure, ...) already surfaces as a safe
    // "error" event; a missing host/port deserves the exact same
    // treatment, not a special case that crashes the caller instead.
    if (!this.host || !this.port) {
      setImmediate(() => this.emit("error", new Error(`Connection requires both host and port (got host=${JSON.stringify(this.host)}, port=${JSON.stringify(this.port)})`)));
      return;
    }
    this._closedByCaller = false;
    this.socket = net.createConnection({ host: this.host, port: this.port });
    this.socket.on("connect", () => {
      this.connected = true;
      this._reconnectDelay = RECONNECT_INITIAL_MS; // a real connection succeeded - forget any backoff built up from earlier failed attempts
      this.emit("open");
    });
    // Raw Buffer, deliberately not pre-decoded as UTF-8 text here - a
    // binary protocol (e.g. MQTT) fed through .toString("utf8") gets bytes
    // that aren't valid UTF-8 silently replaced/corrupted, and there's no
    // way to recover the original bytes afterward. A text-protocol driver
    // (e.g. DSC's pure-ASCII TPI) just calls chunk.toString("utf8") itself
    // on the first line of its own onData - one cheap call, and it keeps
    // the choice of interpretation where it belongs: with the driver that
    // knows what protocol it's actually speaking.
    this.socket.on("data", (chunk) => this.emit("data", chunk));
    this.socket.on("close", () => {
      this.connected = false;
      this.emit("close");
      // "close" fires exactly once per connection attempt, always after
      // any "error" on the same attempt (Node emits error then close) - so
      // scheduling the retry from here alone avoids double-scheduling that
      // listening on "error" too would cause.
      this._scheduleReconnect();
    });
    this.socket.on("error", (err) => this.emit("error", err));
  }
  _scheduleReconnect() {
    if (this._closedByCaller) return; // deliberately stopped (e.g. the admin UI's Stop button) - don't self-heal a connection nobody asked to keep
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => this.open(), this._reconnectDelay);
    if (this._reconnectTimer.unref) this._reconnectTimer.unref();
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, RECONNECT_MAX_MS);
  }
  send(data) {
    if (this.socket && this.connected) this.socket.write(data);
  }
  close() {
    this._closedByCaller = true;
    clearTimeout(this._reconnectTimer);
    if (this.socket) this.socket.destroy();
  }
}

class HttpClient {
  // For request/response devices that have no persistent connection to
  // hold open (e.g. a device with a plain local HTTP API) - just a
  // baseUrl helper. Drivers call the sandbox's global fetch() directly.
  constructor({ host, port }) {
    this.baseUrl = `http://${host}:${port || 80}`;
  }
}

class Clock {
  // Explicit, plainly-named scheduling primitives instead of a
  // restart-yourself timer object. Every handle exposes .cancel().
  every(ms, fn) {
    const handle = setInterval(fn, ms);
    return { cancel: () => clearInterval(handle) };
  }
  after(ms, fn) {
    const handle = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(handle) };
  }
}

class DriverInstance extends EventEmitter {
  constructor(manifest, driverModule, config) {
    super();
    this.manifest = manifest;
    this.config = config;
    this.state = new Map();
    this.clock = new Clock();
    this.transport = (config.connection && config.connection.transport) || "tcp";
    this.connection = this.transport === "tcp" ? new Connection(config.connection) : null;
    this.http = this.transport === "http" ? new HttpClient(config.connection) : null;
    this.actionHandlers = new Map();

    const ctx = {
      connection: this.connection,
      http: this.http,
      clock: this.clock,
      config: this.config,
      log: (...args) => console.log(`[${manifest.id}]`, ...args),
      setState: (id, value, instanceKey) => {
        const key = instanceKey !== undefined ? `${id}#${instanceKey}` : id;
        this.state.set(key, value);
        this.emit("state", { id, instanceKey, value });
      },
      getState: (id, instanceKey) => {
        const key = instanceKey !== undefined ? `${id}#${instanceKey}` : id;
        return this.state.get(key);
      },
      emitEvent: (eventId, params) => this.emit("event", { id: eventId, params }),
      onAction: (actionId, handler) => this.actionHandlers.set(actionId, handler),
    };

    this.impl = driverModule.create(ctx);
    if (this.connection) {
      this.connection.on("open", () => this._guarded("onConnect", () => this.impl.onConnect && this.impl.onConnect()));
      this.connection.on("close", () => this._guarded("onDisconnect", () => this.impl.onDisconnect && this.impl.onDisconnect()));
      this.connection.on("data", (chunk) => this._guarded("onData", () => this.impl.onData && this.impl.onData(chunk)));
      // Node's EventEmitter throws an "error" event as an uncaught
      // exception when nothing is listening for it - a raw socket error
      // (e.g. ECONNREFUSED while a device is off/unreachable, a perfectly
      // normal and expected condition any TCP-transport driver needs to
      // tolerate and retry through) would otherwise crash out as a
      // misleading "[FATAL - uncaught]" instead of the same safe,
      // recoverable "error" event every other driver-code failure already
      // goes through via _guarded() above.
      this.connection.on("error", (err) => this.emit("error", { where: "connection", error: err }));
    }
  }

  getAllState() {
    return Object.fromEntries(this.state);
  }

  // Every entry point into driver code goes through here - a bug in one
  // driver instance's callback becomes an "error" event on that instance,
  // never an uncaught exception that could take down a host process
  // running many instances at once.
  // Catches synchronous throws (the try/catch below) AND async rejections
  // (the .catch() below) from whatever fn() returns - found live on a real
  // running instance (eisy) that without the latter, an async action
  // handler's rejection became an unhandled promise rejection instead of
  // a normal, visible "error" event: every ctx.onAction handler funnels
  // through action() -> _guarded(), and action()'s own caller (server.js's
  // REST route) never awaits or catches the promise action() returns, so
  // a rejecting async handler had nothing else to catch it either. This
  // was the exact architectural root cause behind three separate bugs
  // manually found and fixed driver-by-driver earlier in this project
  // (wemo, ecobee, netatmo, unifi-network, eisy, tesla) before finally
  // being fixed once here instead - every future driver (including any
  // future community/uploaded one) now gets this for free, rather than
  // depending on its author remembering to wrap their own async body in
  // try/catch.
  _guarded(where, fn) {
    try {
      const result = fn();
      if (result && typeof result.then === "function") {
        result.catch((err) => this.emit("error", { where, error: err }));
      }
      return result;
    } catch (err) {
      this.emit("error", { where, error: err });
    }
  }

  start() {
    if (this.connection) {
      this.connection.open();
    } else {
      // No persistent connection to open (e.g. an HTTP request/response
      // device) - the driver is considered "connected" as soon as we ask
      // it to start.
      this._guarded("onConnect", () => this.impl.onConnect && this.impl.onConnect());
    }
  }

  // Symmetric with start(): a TCP-backed instance tears down through the
  // same "close" event onDisconnect already listens on; an HTTP-backed one
  // (no persistent Connection to close) gets onDisconnect invoked directly,
  // same as start()'s "no connection to open" branch calls onConnect
  // directly. Callers (the orchestrator's stop/edit/remove instance
  // handlers) are expected to drop this DriverInstance afterward rather
  // than reuse it - there's no restart-in-place, just create a fresh one.
  stop() {
    if (this.connection) {
      this.connection.close();
    } else {
      this._guarded("onDisconnect", () => this.impl.onDisconnect && this.impl.onDisconnect());
    }
  }

  action(actionId, params) {
    const handler = this.actionHandlers.get(actionId);
    if (!handler) throw new Error(`Unknown action: ${actionId}`);
    return this._guarded(`action:${actionId}`, () => handler(params || {}));
  }
}

function loadDriver(driverDir, config) {
  const manifest = JSON.parse(fs.readFileSync(path.join(driverDir, "manifest.json"), "utf8"));
  const driverModule = loadDriverModule(driverDir);
  return new DriverInstance(manifest, driverModule, config);
}

module.exports = { loadDriver, Connection, HttpClient, Clock, DriverInstance };
