"use strict";
// Philips Hue driver over the bridge's own local REST API (developers.
// meethue.com/develop/hue-api) - no cloud involved, the bridge is a plain
// local HTTP device. The "username" setting is Hue's own term for the
// per-application token you get once via their button-press pairing flow
// (POST {"devicetype":"oak"} to /api while pressing the bridge's physical
// Link button) - not a real username/password, just what Hue calls it.
// State is polled (like http-relay/generic-dimmer) rather than pushed -
// the bridge's newer eventstream API needs HTTPS + a self-signed cert
// dance that's out of proportion to what this driver needs.
function create(ctx) {
  const baseUrl = ctx.http.baseUrl;
  const username = (ctx.config.settings && ctx.config.settings.username) || "";
  let pollHandle = null;
  let lastState = new Map(); // lightId -> "on:bri" snapshot string

  function lightsUrl(suffix) {
    return `${baseUrl}/api/${username}/lights${suffix || ""}`;
  }

  async function fetchStatus() {
    try {
      const res = await fetch(lightsUrl());
      const data = await res.json();
      if (data && data[0] && data[0].error) {
        ctx.log("status poll failed:", data[0].error.description);
        return;
      }
      for (const [id, light] of Object.entries(data || {})) {
        const st = light.state || {};
        const snapshot = `${st.on}:${st.bri}`;
        if (lastState.get(id) === snapshot) continue;
        lastState.set(id, snapshot);
        ctx.setState("light.on", Boolean(st.on), id);
        ctx.setState("light.level", Math.round(((st.bri || 0) / 254) * 100), id);
        ctx.emitEvent("stateChanged", { lightId: id, on: Boolean(st.on) });
      }
    } catch (err) {
      ctx.log("status poll failed:", err.message);
    }
  }

  async function setLightState(lightId, body) {
    try {
      const res = await fetch(lightsUrl(`/${lightId}/state`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (Array.isArray(data) && data[0] && data[0].error) {
        ctx.log(`setLightState(${lightId}) failed:`, data[0].error.description);
        return;
      }
      await fetchStatus();
    } catch (err) {
      ctx.log(`setLightState(${lightId}) failed:`, err.message);
    }
  }

  ctx.onAction("lightOn", ({ lightId }) => setLightState(lightId, { on: true }));
  ctx.onAction("lightOff", ({ lightId }) => setLightState(lightId, { on: false }));
  ctx.onAction("setBrightness", ({ lightId, level = 100 }) => {
    const bri = Math.round((Math.max(0, Math.min(100, level)) / 100) * 254);
    return setLightState(lightId, { on: bri > 0, bri: Math.max(1, bri) });
  });
  ctx.onAction("discoverLights", async () => {
    try {
      const res = await fetch(lightsUrl());
      const data = await res.json();
      if (data && data[0] && data[0].error) {
        ctx.log("discoverLights failed:", data[0].error.description);
        return;
      }
      const nodes = Object.entries(data || {}).map(([id, light]) => ({ address: id, name: light.name || `Light ${id}` }));
      ctx.setState("discovery.nodes", JSON.stringify(nodes));
      ctx.emitEvent("nodesDiscovered", { count: nodes.length });
    } catch (err) {
      ctx.log("discoverLights failed:", err.message);
    }
  });

  return {
    onConnect() {
      ctx.log("Polling", lightsUrl());
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
