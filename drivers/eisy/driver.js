"use strict";
// Universal Devices ISY994/eisy driver over their own published REST +
// WebSocket API (not RTI-specific - UDI documents these endpoints/
// commands themselves for any third-party integrator, independent of any
// particular control system): GET /rest/status for one initial baseline
// read, then a live WS subscription at /rest/subscribe for real-time node
// updates (no polling once connected), and GET /rest/nodes/<address>/
// cmd/<command>[/<value>] to send a command. DON/DOF (Insteon's own
// standard "device on"/"device off" mnemonics) and CLISPH/CLISPC (climate
// setpoint heat/cool) are UDI's own real command vocabulary, not invented
// here. The WS handshake (Sec-WebSocket-Protocol: ISYSUB, a specific
// Origin, Basic auth) and the <control>/<node>/<action> event shape were
// both confirmed against a real eisy unit on the local network before
// writing this, not guessed - a bare WebSocket upgrade with only the
// standard headers gets a 400, the ISYSUB protocol + Origin combination
// is what actually gets a 101.
//
// Node addresses (e.g. "18 22 4B 1") are a free-form action/state
// parameter rather than individually declared in the manifest - a real
// ISY/eisy dynamically discovers however many nodes exist on the
// controller, which Oak's static manifest has no way to enumerate ahead
// of time, so each node is addressed manually per Dashboard slot (same
// "zone" fixed-argument pattern zone-hub uses for its own zones).

// Some eisy units serve the legacy "local account" (e.g. admin/admin)
// only over a self-signed HTTPS port (often 8443), independent of - and
// sometimes still working even after - the equivalent HTTP port (often
// 8080) stops responding; found live on a real running instance whose
// HTTP-8080 timed out completely while HTTPS-8443 with the same local
// credentials worked. Own https.Agent scoped to just this driver's own
// requests, same pattern as ../vizio-smartcast/../tesla-powerwall -
// never touches global NODE_TLS_REJECT_UNAUTHORIZED.
const https = require("https");
const insecureAgent = new https.Agent({ rejectUnauthorized: false });
function httpsRequest(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { agent: insecureAgent, headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, ok: res.statusCode < 400, text: async () => body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function xmlAttr(tag, name) {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : undefined;
}

// Minimal purpose-built extractor for ISY's /rest/status response shape
// (<node id="..."><property id="ST" value="..." .../></node> repeated) -
// used once at connect time for the initial baseline read. Not a general
// XML parser, Oak has no XML dependency and this is the only shape this
// driver ever needs to read here.
function parseNodes(xml) {
  const nodes = {};
  const nodeRe = /<node id="([^"]+)">([\s\S]*?)<\/node>/g;
  let nodeMatch;
  while ((nodeMatch = nodeRe.exec(xml))) {
    const address = nodeMatch[1];
    const props = {};
    const propRe = /<property\s+([^/]*)\/>/g;
    let propMatch;
    while ((propMatch = propRe.exec(nodeMatch[2]))) {
      const id = xmlAttr(propMatch[1], "id");
      const value = xmlAttr(propMatch[1], "value");
      if (id && value !== undefined) props[id] = value;
    }
    nodes[address] = props;
  }
  return nodes;
}

// /rest/nodes lists every actual device (skip <group> elements - those
// are scenes, not individually addressable devices) with its own
// <address>/<name> pair, confirmed against a real eisy unit. Used only by
// the discoverNodes action - a one-shot "here's what's out there" read,
// not part of the normal connect/poll/event path.
function parseNodeList(xml) {
  const nodes = [];
  // \b (not a literal space) so this matches both a real unit's
  // <node flag="..." nodeDefId="...">...</node> and a bare <node>...
  // </node> - real hardware always has attributes here, but there's no
  // reason to assume that's the only valid shape UDI could ever send.
  const nodeRe = /<node\b[^>]*>([\s\S]*?)<\/node>/g;
  let m;
  while ((m = nodeRe.exec(xml))) {
    const address = (m[1].match(/<address>([^<]*)<\/address>/) || [])[1];
    const name = (m[1].match(/<name>([^<]*)<\/name>/) || [])[1];
    if (address) nodes.push({ address, name: name || address });
  }
  return nodes;
}

// The real-time event stream's message shape: <Event seqnum="..."
// sid="..." timestamp="..."><control>ST</control><action uom="100"
// prec="0">255</action><node>18 22 4B 1</node><eventInfo/></Event> - note
// <action> carries attributes (uom/prec) on real hardware, confirmed by
// capturing actual traffic from a real eisy unit; a naive "<action>" (no
// attributes) match silently fails to extract the value against real
// devices even though it works fine against a hand-written test double
// that doesn't happen to add those attributes - exactly the gap this
// project's own established practice of real-hardware testing exists to
// catch. A system-level event (heartbeat, sync status, etc.) has an EMPTY
// <node></node> tag, not a missing one, which the caller's falsy check on
// the extracted empty string already handles correctly either way.
function parseEvent(xml) {
  const control = (xml.match(/<control>([^<]*)<\/control>/) || [])[1];
  const node = (xml.match(/<node>([^<]*)<\/node>/) || [])[1];
  const action = (xml.match(/<action[^>]*>([^<]*)<\/action>/) || [])[1];
  return { control, node, action };
}

function create(ctx) {
  const useHttps = Boolean(ctx.config.settings && ctx.config.settings.useHttps);
  // Built directly from connection fields rather than ctx.http.baseUrl,
  // which hardcodes an "http://" scheme with no way to opt into https.
  const baseUrl = `${useHttps ? "https" : "http"}://${ctx.config.connection.host}:${ctx.config.connection.port || (useHttps ? 8443 : 80)}`;
  const username = (ctx.config.settings && ctx.config.settings.username) || "";
  const password = (ctx.config.settings && ctx.config.settings.password) || "";
  const authHeader = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
  // Unified request helper so every call site below works under either
  // scheme without an if/else at each one - global fetch() can't be
  // pointed at a self-signed cert without touching Node's global TLS
  // settings, so HTTPS mode routes through the raw https.request()
  // helper above instead.
  function request(path, headers) {
    const url = `${baseUrl}${path}`;
    return useHttps ? httpsRequest(url, headers) : fetch(url, { headers });
  }
  const RECONNECT_MS = 5000;
  // Staleness-detection reconnect, ported from a proven design in this
  // project's own prior QTI/RTI-ecosystem eisy driver (workshop/eisy):
  // that driver's own header comment records observing, on a real eISY,
  // that the subscribe connection can go silently stale and stay
  // reported as "connected" indefinitely with no further events ever
  // arriving - nothing about a close/error event ever fires, so the
  // existing reconnect-on-close logic above never notices. Confirmed
  // independently here too: a raw test script bypassing this driver
  // entirely showed the same behavior against a real eisy - the WS
  // stayed "open" while genuinely new events stopped arriving. Fixed the
  // same way that prior driver fixed it: track the last time ANY message
  // arrived (including heartbeats) and force a reconnect if it's been
  // too long, rather than trusting the socket's own open/close state.
  // 180s, not something shorter, matches that driver's own tuning - a
  // shorter interval risks reconnecting before a real event ever gets a
  // chance to arrive under load.
  const STALE_MS = 180000;
  let lastActivityTime = 0;
  let staleCheckTimer = null;
  let ws = null;
  let reconnectHandle = null;
  let stopped = false;
  // Last-seen Insteon-native values (ST 0-255, setpoints x10) per node -
  // used only to skip redundant setState/emitEvent calls when a duplicate
  // update arrives, same throttle-on-change pattern every other Oak
  // driver in this project already uses.
  let lastRaw = {};

  function applyNodeProp(address, propId, rawValue) {
    const prev = lastRaw[address] || {};
    if (prev[propId] === rawValue) return;
    lastRaw[address] = { ...prev, [propId]: rawValue };
    if (propId === "ST") {
      const raw = Number(rawValue);
      ctx.setState("node.on", raw > 0, address);
      ctx.setState("node.level", Math.round((raw / 255) * 100), address);
      ctx.emitEvent("stateChanged", { address, property: "ST", value: raw });
    } else if (propId === "CLISPH") {
      ctx.setState("climate.heatSetpoint", Math.round(Number(rawValue) / 10), address);
      ctx.emitEvent("stateChanged", { address, property: "CLISPH", value: Number(rawValue) / 10 });
    } else if (propId === "CLISPC") {
      ctx.setState("climate.coolSetpoint", Math.round(Number(rawValue) / 10), address);
      ctx.emitEvent("stateChanged", { address, property: "CLISPC", value: Number(rawValue) / 10 });
    } else if (propId === "ERR") {
      // 0 = responding normally, non-zero = a communication error with
      // this device - confirmed against a real unit's own property name
      // attribute ("Responding") on this exact property id.
      ctx.setState("node.error", Number(rawValue) > 0, address);
      ctx.emitEvent("stateChanged", { address, property: "ERR", value: Number(rawValue) });
    }
  }

  async function fetchInitialStatus() {
    try {
      const res = await request("/rest/status", { Authorization: authHeader });
      const xml = await res.text();
      const nodes = parseNodes(xml);
      for (const [address, props] of Object.entries(nodes)) {
        for (const [propId, value] of Object.entries(props)) applyNodeProp(address, propId, value);
      }
    } catch (err) {
      ctx.log("initial status fetch failed:", err.message);
    }
  }

  function connectEventStream() {
    if (stopped) return;
    const wsUrl = baseUrl.replace(/^http/, "ws") + "/rest/subscribe";
    ws = new WebSocket(wsUrl, "ISYSUB", {
      headers: { Authorization: authHeader, Origin: "com.universal-devices.websockets.isy" },
      // baseUrl.replace(/^http/,"ws") turns "https://" into "wss://"
      // correctly (the regex only matches the "http" prefix, leaving the
      // trailing "s") - rejectUnauthorized here is the ws package's own
      // pass-through to its underlying TLS socket options, scoped to just
      // this connection like the HTTPS agent above.
      ...(useHttps ? { rejectUnauthorized: false } : {}),
    });
    ws.on("open", () => {
      lastActivityTime = Date.now();
      ctx.log("Event stream connected:", wsUrl);
    });
    ws.on("message", (data) => {
      lastActivityTime = Date.now(); // any message counts, including heartbeats - see checkStaleness below
      const xml = data.toString();
      const { control, node, action } = parseEvent(xml);
      if (!control || !node || action === undefined) return; // heartbeat or non-node message
      if (control === "ST" || control === "CLISPH" || control === "CLISPC" || control === "ERR") applyNodeProp(node, control, action);
    });
    ws.on("close", () => {
      if (stopped) return;
      ctx.log(`Event stream disconnected, reconnecting in ${RECONNECT_MS}ms`);
      reconnectHandle = ctx.clock.after(RECONNECT_MS, connectEventStream);
    });
    ws.on("error", (err) => ctx.log("Event stream error:", err.message));
  }

  async function sendCommand(address, control, value) {
    try {
      const path = value !== undefined ? `/rest/nodes/${encodeURIComponent(address)}/cmd/${control}/${value}` : `/rest/nodes/${encodeURIComponent(address)}/cmd/${control}`;
      // No fetchStatus() after the command the way the old polling version
      // needed - the event stream reports the resulting state change itself.
      // Connection: close - found on a real unit that its HTTP server's
      // Keep-Alive timeout (5s) is short enough that Node's fetch() can
      // hand back a pooled socket the server already dropped, surfacing
      // as a generic "fetch failed" TypeError with no HTTP status at all;
      // forcing a fresh connection per command avoids this, and the cost
      // is negligible since a command is a rare, human-paced action, not
      // a high-frequency one.
      await request(path, { Authorization: authHeader, Connection: "close" });
    } catch (err) {
      // Without this try/catch, a network hiccup here becomes an
      // unhandled promise rejection - confirmed on a real running
      // instance: every onAction below funnels through this function, so
      // one missing try/catch silently swallowed every node on/off/level
      // command with zero feedback anywhere (not even entry.lastError).
      ctx.log(`Command failed (${address} ${control}): ${err.message}`);
    }
  }

  ctx.onAction("nodeOn", ({ address }) => sendCommand(address, "DON"));
  ctx.onAction("nodeOff", ({ address }) => sendCommand(address, "DOF"));
  ctx.onAction("nodeSetLevel", ({ address, level = 100 }) => sendCommand(address, "DON", Math.round((Math.max(0, Math.min(100, level)) / 100) * 255)));
  ctx.onAction("climateSetHeatSetpoint", ({ address, setpoint = 68 }) => sendCommand(address, "CLISPH", Math.round(setpoint * 10)));
  ctx.onAction("climateSetCoolSetpoint", ({ address, setpoint = 76 }) => sendCommand(address, "CLISPC", Math.round(setpoint * 10)));

  // Escape hatch for any Insteon/Z-Wave command UDI supports that isn't
  // one of the specific actions above (locks, fans, ramp rate, beep,
  // etc.) - deliberately not enumerated as named actions, since guessing
  // at device-type-specific command codes without real hardware of that
  // type to verify against is exactly the mistake this project's own
  // established practice (verify against real hardware, don't guess) is
  // meant to avoid. UDI's own command vocabulary, entered by whoever
  // knows their specific device's codes.
  ctx.onAction("sendRawCommand", ({ address, control, value }) => sendCommand(address, control, value));

  // A real ISY/eisy dynamically discovers however many nodes exist - this
  // reads that list once on request and reports it as a state (JSON
  // array of {address, name}) rather than a return value, since actions
  // are fire-and-forget from the HTTP caller's side (see server.js's
  // action route, which doesn't await/forward a handler's result). The
  // admin UI reads this state back and offers to import it into the
  // deviceNames setting.
  ctx.onAction("discoverNodes", async () => {
    try {
      const res = await request("/rest/nodes", { Authorization: authHeader });
      const xml = await res.text();
      const nodes = parseNodeList(xml);
      ctx.setState("discovery.nodes", JSON.stringify(nodes));
      ctx.emitEvent("nodesDiscovered", { count: nodes.length });
    } catch (err) {
      ctx.log("node discovery failed:", err.message);
    }
  });

  // Programs (/rest/programs/<id>/<command>) and variables
  // (/rest/vars/set/<type>/<id>/<value>) - UDI's own real REST paths,
  // confirmed against a real eisy unit (both endpoints respond correctly
  // even with none of either actually configured on this particular
  // unit). No Dashboard-slot binding surface for these yet (they don't
  // fit the on/off/level model), reachable via the Driver tab's raw
  // Actions panel or a macro in the meantime.
  async function programCmd(programId, command) {
    try {
      await request(`/rest/programs/${encodeURIComponent(programId)}/${command}`, { Authorization: authHeader, Connection: "close" });
    } catch (err) {
      ctx.log(`Program command failed (${programId} ${command}): ${err.message}`);
    }
  }
  ctx.onAction("runProgram", ({ programId, clause = "run" }) => programCmd(programId, clause));
  ctx.onAction("enableProgram", ({ programId }) => programCmd(programId, "enable"));
  ctx.onAction("disableProgram", ({ programId }) => programCmd(programId, "disable"));
  ctx.onAction("setVariable", async ({ varType = 2, varId, value }) => {
    try {
      await request(`/rest/vars/set/${varType}/${varId}/${value}`, { Authorization: authHeader, Connection: "close" });
    } catch (err) {
      ctx.log(`setVariable failed (${varType}/${varId}): ${err.message}`);
    }
  });

  // Polling fallback, supplementing (not replacing) the event stream -
  // found live on a real running instance that the WS subscribe channel
  // can silently stop pushing genuinely new events (a raw independent
  // test confirmed it replays a historical backlog on connect but then
  // delivers nothing further even after a real command changed a real
  // node's state) while still reporting itself as connected the whole
  // time - no close/error event fires, so connectEventStream's own
  // reconnect logic never notices anything is wrong. Without this,
  // Oak's state only reflects reality immediately after a restart
  // (fetchInitialStatus's one-shot baseline read) and silently goes
  // stale the moment something changes afterward. Reuses the
  // pollIntervalMs setting, which pre-dates this driver's current
  // event-only design (an earlier version polled exclusively, per this
  // file's own "no fetchStatus() after the command" comment above) and
  // was otherwise sitting unused.
  let pollTimer = null;

  // Checked periodically rather than via a single long setTimeout so it
  // keeps working across any number of reconnects without needing to be
  // rescheduled from inside connectEventStream itself - a light
  // reconnect (terminate + reopen, no full status refetch) mirrors the
  // referenced driver's own reasoning: the node list is already known,
  // so there's no need to redo discovery just to re-subscribe.
  function checkStaleness() {
    if (stopped || !lastActivityTime) return;
    if (Date.now() - lastActivityTime > STALE_MS) {
      ctx.log(`No subscription activity in over ${STALE_MS / 1000}s - reopening event stream`);
      if (reconnectHandle) reconnectHandle.cancel(); // avoid a second, redundant reconnect stacking on top of this one
      if (ws) {
        ws.removeAllListeners("close"); // this is already a deliberate reconnect - the normal close handler's own reconnectHandle would otherwise schedule a duplicate
        ws.terminate();
      }
      connectEventStream();
    }
  }

  return {
    async onConnect() {
      ctx.log("Connecting to", baseUrl);
      await fetchInitialStatus();
      connectEventStream();
      const pollMs = Number(ctx.config.settings && ctx.config.settings.pollIntervalMs) || 5000;
      pollTimer = ctx.clock.every(pollMs, fetchInitialStatus);
      staleCheckTimer = ctx.clock.every(30000, checkStaleness);
    },
    onDisconnect() {
      stopped = true;
      if (reconnectHandle) reconnectHandle.cancel();
      if (pollTimer) pollTimer.cancel();
      if (staleCheckTimer) staleCheckTimer.cancel();
      if (ws) ws.terminate();
    },
  };
}

module.exports = { create };
