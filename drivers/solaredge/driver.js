"use strict";
// SolarEdge driver over their own published Monitoring API
// (developer.solaredge.com) - real, official, well documented, high
// confidence. Read-only by design: SolarEdge's public API is a
// monitoring API, it has no inverter control endpoints - this driver
// doesn't invent any.
const API_BASE = "https://monitoringapi.solaredge.com";
const POLL_MS = 5 * 60 * 1000;

function create(ctx) {
  let pollHandle = null;

  async function refresh() {
    const { apiKey, siteId } = ctx.config.settings;
    if (!apiKey || !siteId) return;
    try {
      const overview = await fetch(`${API_BASE}/site/${siteId}/overview?api_key=${apiKey}`).then((r) => r.json());
      const data = overview.overview;
      if (!data) return;
      ctx.setState("power.current", data.currentPower && data.currentPower.power);
      ctx.setState("energy.today", data.lastDayData && data.lastDayData.energy);
      ctx.setState("energy.lifetime", data.lifeTimeData && data.lifeTimeData.energy);
    } catch (err) {
      ctx.log(`Refresh failed: ${err.message}`);
    }
  }
  ctx.onAction("refresh", () => refresh());

  return {
    onConnect() {
      refresh();
      pollHandle = ctx.clock.every(POLL_MS, refresh);
    },
    onDisconnect() {
      if (pollHandle) pollHandle.cancel();
    },
  };
}

module.exports = { create };
