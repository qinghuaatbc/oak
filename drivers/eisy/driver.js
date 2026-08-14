"use strict";
// Universal Devices ISY994/eisy driver over their own published REST API
// (not RTI-specific - UDI documents these endpoints/commands themselves
// for any third-party integrator, independent of any particular control
// system): GET /rest/status polls every node's current property values
// as XML, GET /rest/nodes/<address>/cmd/<command>[/<value>] sends a
// command. DON/DOF (Insteon's own standard "device on"/"device off"
// mnemonics) and CLISPH/CLISPC (climate setpoint heat/cool) are UDI's
// own real command vocabulary, not invented here.
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
// not a general XML parser, Oak has no XML dependency and this is the
// only shape this driver ever needs to read.
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

function create(ctx) {
  const baseUrl = ctx.http.baseUrl;
  const username = (ctx.config.settings && ctx.config.settings.username) || "";
  const password = (ctx.config.settings && ctx.config.settings.password) || "";
  const authHeader = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
  let pollHandle = null;
  // Last-seen Insteon-native values (ST 0-255, setpoints x10) per node -
  // used only to skip redundant setState/emitEvent calls when a poll
  // returns unchanged data, same throttle-on-change pattern every other
  // Oak driver in this project already uses.
  let lastRaw = {};

  async function fetchStatus() {
    try {
      const res = await fetch(`${baseUrl}/rest/status`, { headers: { Authorization: authHeader } });
      const xml = await res.text();
      const nodes = parseNodes(xml);
      for (const [address, props] of Object.entries(nodes)) {
        const prev = lastRaw[address] || {};
        const next = { ...prev };
        if ("ST" in props && props.ST !== prev.ST) {
          next.ST = props.ST;
          const raw = Number(props.ST);
          ctx.setState("node.on", raw > 0, address);
          ctx.setState("node.level", Math.round((raw / 255) * 100), address);
          ctx.emitEvent("stateChanged", { address, property: "ST", value: raw });
        }
        if ("CLISPH" in props && props.CLISPH !== prev.CLISPH) {
          next.CLISPH = props.CLISPH;
          ctx.setState("climate.heatSetpoint", Math.round(Number(props.CLISPH) / 10), address);
          ctx.emitEvent("stateChanged", { address, property: "CLISPH", value: Number(props.CLISPH) / 10 });
        }
        if ("CLISPC" in props && props.CLISPC !== prev.CLISPC) {
          next.CLISPC = props.CLISPC;
          ctx.setState("climate.coolSetpoint", Math.round(Number(props.CLISPC) / 10), address);
          ctx.emitEvent("stateChanged", { address, property: "CLISPC", value: Number(props.CLISPC) / 10 });
        }
        lastRaw[address] = next;
      }
    } catch (err) {
      ctx.log("status poll failed:", err.message);
    }
  }

  async function sendCommand(address, control, value) {
    const path = value !== undefined ? `/rest/nodes/${encodeURIComponent(address)}/cmd/${control}/${value}` : `/rest/nodes/${encodeURIComponent(address)}/cmd/${control}`;
    await fetch(`${baseUrl}${path}`, { headers: { Authorization: authHeader } });
    await fetchStatus();
  }

  ctx.onAction("nodeOn", ({ address }) => sendCommand(address, "DON"));
  ctx.onAction("nodeOff", ({ address }) => sendCommand(address, "DOF"));
  ctx.onAction("nodeSetLevel", ({ address, level = 100 }) => sendCommand(address, "DON", Math.round((Math.max(0, Math.min(100, level)) / 100) * 255)));
  ctx.onAction("climateSetHeatSetpoint", ({ address, setpoint = 68 }) => sendCommand(address, "CLISPH", Math.round(setpoint * 10)));
  ctx.onAction("climateSetCoolSetpoint", ({ address, setpoint = 76 }) => sendCommand(address, "CLISPC", Math.round(setpoint * 10)));

  return {
    onConnect() {
      ctx.log("Polling", baseUrl);
      fetchStatus();
      const intervalMs = (ctx.config.settings && ctx.config.settings.pollIntervalMs) || 5000;
      pollHandle = ctx.clock.every(intervalMs, () => fetchStatus());
    },
    onDisconnect() {
      if (pollHandle) pollHandle.cancel();
    },
  };
}

module.exports = { create };
