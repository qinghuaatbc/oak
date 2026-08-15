"use strict";
// LIFX driver over their own published Cloud HTTP API (api.developer.lifx.com)
// - unlike Hue's local bridge, LIFX's real, documented control surface for
// third-party apps is this cloud API (a Bearer token from cloud.lifx.com/
// settings), so that's what this driver speaks rather than reverse-
// engineering their local LAN protocol. Polled (like every other simple
// HTTP driver in this project) since the cloud API has no push mechanism
// for third-party apps.
const API_BASE = "https://api.lifx.com/v1";

function create(ctx) {
  const apiToken = (ctx.config.settings && ctx.config.settings.apiToken) || "";
  let pollHandle = null;
  let lastState = new Map(); // lightId -> "power:brightness" snapshot

  function authHeaders() {
    return { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" };
  }

  async function fetchStatus() {
    try {
      const res = await fetch(`${API_BASE}/lights/all`, { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) {
        ctx.log("status poll failed:", (data && data.error) || `HTTP ${res.status}`);
        return;
      }
      for (const light of data) {
        const snapshot = `${light.power}:${light.brightness}`;
        if (lastState.get(light.id) === snapshot) continue;
        lastState.set(light.id, snapshot);
        ctx.setState("light.on", light.power === "on", light.id);
        ctx.setState("light.level", Math.round((light.brightness || 0) * 100), light.id);
        ctx.emitEvent("stateChanged", { lightId: light.id, on: light.power === "on" });
      }
    } catch (err) {
      ctx.log("status poll failed:", err.message);
    }
  }

  async function setLightState(lightId, body) {
    try {
      const res = await fetch(`${API_BASE}/lights/id:${encodeURIComponent(lightId)}/state`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        ctx.log(`setLightState(${lightId}) failed:`, (data && data.error) || `HTTP ${res.status}`);
        return;
      }
      await fetchStatus();
    } catch (err) {
      ctx.log(`setLightState(${lightId}) failed:`, err.message);
    }
  }

  ctx.onAction("lightOn", ({ lightId }) => setLightState(lightId, { power: "on" }));
  ctx.onAction("lightOff", ({ lightId }) => setLightState(lightId, { power: "off" }));
  ctx.onAction("setBrightness", ({ lightId, level = 100 }) => {
    const brightness = Math.max(0, Math.min(100, level)) / 100;
    return setLightState(lightId, { power: brightness > 0 ? "on" : "off", brightness });
  });
  ctx.onAction("discoverLights", async () => {
    try {
      const res = await fetch(`${API_BASE}/lights/all`, { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) {
        ctx.log("discoverLights failed:", (data && data.error) || `HTTP ${res.status}`);
        return;
      }
      const nodes = data.map((light) => ({ address: light.id, name: light.label || light.id }));
      ctx.setState("discovery.nodes", JSON.stringify(nodes));
      ctx.emitEvent("nodesDiscovered", { count: nodes.length });
    } catch (err) {
      ctx.log("discoverLights failed:", err.message);
    }
  });

  return {
    onConnect() {
      ctx.log("Polling LIFX Cloud API");
      fetchStatus();
      const intervalMs = (ctx.config.settings && ctx.config.settings.pollIntervalMs) || 5000;
      pollHandle = ctx.clock.every(intervalMs, fetchStatus);
    },
    onDisconnect() {
      if (pollHandle) pollHandle.cancel();
    },
  };
}
module.exports = { create };
