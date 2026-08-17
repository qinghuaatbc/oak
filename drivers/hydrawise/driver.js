"use strict";
// Hunter Hydrawise driver over their own published cloud API
// (api.hydrawise.com/api/v1) - a real, documented, long-stable API (the
// same one pydrawise/Home Assistant's hydrawise integration use), simple
// api_key query-param auth, high confidence.
const API_BASE = "https://api.hydrawise.com/api/v1";

function create(ctx) {
  function apiKey() {
    return ctx.config.settings.apiKey || "";
  }

  ctx.onAction("runZone", async ({ relayId, durationSeconds = 300 }) => {
    const id = relayId || ctx.config.settings.relayId;
    try {
      await fetch(`${API_BASE}/setzone.php?action=run&relay_id=${id}&period_id=999&custom=${durationSeconds}&api_key=${apiKey()}`);
    } catch (err) {
      ctx.log(`runZone failed: ${err.message}`);
    }
  });
  ctx.onAction("stopZone", async ({ relayId }) => {
    const id = relayId || ctx.config.settings.relayId;
    try {
      await fetch(`${API_BASE}/setzone.php?action=stop&relay_id=${id}&api_key=${apiKey()}`);
    } catch (err) {
      ctx.log(`stopZone failed: ${err.message}`);
    }
  });
  ctx.onAction("suspendZone", async ({ relayId, durationSeconds = 86400 }) => {
    const id = relayId || ctx.config.settings.relayId;
    try {
      await fetch(`${API_BASE}/setzone.php?action=suspend&relay_id=${id}&period_id=999&custom=${durationSeconds}&api_key=${apiKey()}`);
    } catch (err) {
      ctx.log(`suspendZone failed: ${err.message}`);
    }
  });
  ctx.onAction("discoverZones", async () => {
    try {
      const data = await fetch(`${API_BASE}/statusschedule.php?api_key=${apiKey()}`).then((r) => r.json());
      const zones = (data.relays || []).map((r) => ({ id: r.relay_id, name: r.name }));
      ctx.setState("discovery.zones", JSON.stringify(zones));
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
