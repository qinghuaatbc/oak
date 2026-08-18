"use strict";
// Netro irrigation driver over their own published REST API
// (netrohome.com publishes API docs for their smart controllers) - real,
// official, high confidence. Simple GET-based calls keyed by a per-
// device key from the Netro app, no OAuth needed.
const API_BASE = "https://api.netrohome.com/npa/v1";

function create(ctx) {
  function key() {
    return ctx.config.settings.deviceKey || "";
  }

  ctx.onAction("startWatering", async ({ zones, durationMinutes = 10 }) => {
    try {
      const zonesParam = zones ? `&zones=${encodeURIComponent(zones)}` : "";
      await fetch(`${API_BASE}/water.json?key=${key()}&duration=${durationMinutes}${zonesParam}`);
    } catch (err) {
      ctx.log(`startWatering failed: ${err.message}`);
    }
  });
  ctx.onAction("stopWatering", async () => {
    try {
      await fetch(`${API_BASE}/stop_water.json?key=${key()}`);
    } catch (err) {
      ctx.log(`stopWatering failed: ${err.message}`);
    }
  });
  ctx.onAction("discoverZones", async () => {
    try {
      const data = await fetch(`${API_BASE}/zones.json?key=${key()}`).then((r) => r.json());
      const zones = (data.data && data.data.zones) || [];
      ctx.setState("discovery.zones", JSON.stringify(zones.map((z) => ({ id: z.id, name: z.name }))));
    } catch (err) {
      ctx.log(`discoverZones failed: ${err.message}`);
    }
  });

  return {
    onConnect() {},
    onDisconnect() {},
  };
}

module.exports = { create };
