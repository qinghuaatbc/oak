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
  const baseUrl = ctx.http.baseUrl;
  const username = (ctx.config.settings && ctx.config.settings.username) || "";
  const password = (ctx.config.settings && ctx.config.settings.password) || "";
  const authHeader = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
  const RECONNECT_MS = 5000;
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
    }
  }

  async function fetchInitialStatus() {
    try {
      const res = await fetch(`${baseUrl}/rest/status`, { headers: { Authorization: authHeader } });
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
    });
    ws.on("open", () => ctx.log("Event stream connected:", wsUrl));
    ws.on("message", (data) => {
      const xml = data.toString();
      const { control, node, action } = parseEvent(xml);
      if (!control || !node || action === undefined) return; // heartbeat or non-node message
      if (control === "ST" || control === "CLISPH" || control === "CLISPC") applyNodeProp(node, control, action);
    });
    ws.on("close", () => {
      if (stopped) return;
      ctx.log(`Event stream disconnected, reconnecting in ${RECONNECT_MS}ms`);
      reconnectHandle = ctx.clock.after(RECONNECT_MS, connectEventStream);
    });
    ws.on("error", (err) => ctx.log("Event stream error:", err.message));
  }

  async function sendCommand(address, control, value) {
    const path = value !== undefined ? `/rest/nodes/${encodeURIComponent(address)}/cmd/${control}/${value}` : `/rest/nodes/${encodeURIComponent(address)}/cmd/${control}`;
    // No fetchStatus() after the command the way the old polling version
    // needed - the event stream reports the resulting state change itself.
    await fetch(`${baseUrl}${path}`, { headers: { Authorization: authHeader } });
  }

  ctx.onAction("nodeOn", ({ address }) => sendCommand(address, "DON"));
  ctx.onAction("nodeOff", ({ address }) => sendCommand(address, "DOF"));
  ctx.onAction("nodeSetLevel", ({ address, level = 100 }) => sendCommand(address, "DON", Math.round((Math.max(0, Math.min(100, level)) / 100) * 255)));
  ctx.onAction("climateSetHeatSetpoint", ({ address, setpoint = 68 }) => sendCommand(address, "CLISPH", Math.round(setpoint * 10)));
  ctx.onAction("climateSetCoolSetpoint", ({ address, setpoint = 76 }) => sendCommand(address, "CLISPC", Math.round(setpoint * 10)));

  return {
    async onConnect() {
      ctx.log("Connecting to", baseUrl);
      await fetchInitialStatus();
      connectEventStream();
    },
    onDisconnect() {
      stopped = true;
      if (reconnectHandle) reconnectHandle.cancel();
      if (ws) ws.terminate();
    },
  };
}

module.exports = { create };
