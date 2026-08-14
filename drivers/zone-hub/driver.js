"use strict";
// Multi-zone hub driver over plain HTTP - ONE running instance backs
// several zones (e.g. "kitchen", "livingroom"), each with its own
// light on/level and climate target. State keys are suffixed per zone
// ("light.on#kitchen", "climate.target#livingroom") - the convention
// Oak's Dashboard bindings use (slot.stateSuffix) to read the right
// zone's value back out of one instance's combined state object.

function create(ctx) {
  const baseUrl = ctx.http.baseUrl;
  let pollHandle = null;
  let lastZones = {};

  async function fetchStatus() {
    try {
      const res = await fetch(`${baseUrl}/zones`);
      const zones = await res.json();
      for (const [zone, z] of Object.entries(zones)) {
        const prev = lastZones[zone] || {};
        if (prev.on !== z.on) ctx.setState("light.on", z.on, zone);
        if (prev.level !== z.level) ctx.setState("light.level", z.level, zone);
        if (prev.target !== z.target) ctx.setState("climate.target", z.target, zone);
        if (prev.on !== z.on || prev.level !== z.level || prev.target !== z.target) {
          ctx.emitEvent("stateChanged", { zone, field: "status", value: z });
        }
      }
      lastZones = zones;
    } catch (err) {
      ctx.log("status poll failed:", err.message);
    }
  }

  async function lightTurn(zone, turn) {
    await fetch(`${baseUrl}/light?zone=${encodeURIComponent(zone)}&turn=${turn}`);
    await fetchStatus();
  }
  async function lightLevel(zone, level) {
    await fetch(`${baseUrl}/light?zone=${encodeURIComponent(zone)}&level=${Math.max(0, Math.min(100, Math.round(level)))}`);
    await fetchStatus();
  }
  async function climateTarget(zone, target) {
    await fetch(`${baseUrl}/climate?zone=${encodeURIComponent(zone)}&target=${Math.round(target)}`);
    await fetchStatus();
  }

  ctx.onAction("lightOn", ({ zone }) => lightTurn(zone, "on"));
  ctx.onAction("lightOff", ({ zone }) => lightTurn(zone, "off"));
  ctx.onAction("lightSetLevel", ({ zone, level = 100 }) => lightLevel(zone, level));
  ctx.onAction("climateSetTarget", ({ zone, target = 70 }) => climateTarget(zone, target));

  return {
    onConnect() {
      ctx.log("Polling", baseUrl);
      fetchStatus();
      const intervalMs = (ctx.config.settings && ctx.config.settings.pollIntervalMs) || 3000;
      pollHandle = ctx.clock.every(intervalMs, () => fetchStatus());
    },
    onDisconnect() {
      if (pollHandle) pollHandle.cancel();
    },
  };
}

module.exports = { create };
