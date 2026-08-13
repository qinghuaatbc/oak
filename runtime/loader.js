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
    Buffer, // needed by any driver speaking a binary protocol (e.g. MQTT) - core Node global
  };
  vm.createContext(sandbox);
  const wrapped = `(function (module, exports, require) {\n${source}\n})`;
  const compiled = vm.runInContext(wrapped, sandbox, { filename: filePath });
  compiled(sandboxModule, sandboxModule.exports, sandbox.require);
  return sandboxModule.exports;
}

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
  }
  open() {
    this.socket = net.createConnection({ host: this.host, port: this.port });
    this.socket.on("connect", () => {
      this.connected = true;
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
    });
    this.socket.on("error", (err) => this.emit("error", err));
  }
  send(data) {
    if (this.socket && this.connected) this.socket.write(data);
  }
  close() {
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
    }
  }

  getAllState() {
    return Object.fromEntries(this.state);
  }

  // Every entry point into driver code goes through here - a bug in one
  // driver instance's callback becomes an "error" event on that instance,
  // never an uncaught exception that could take down a host process
  // running many instances at once.
  _guarded(where, fn) {
    try {
      return fn();
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
