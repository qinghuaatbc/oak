"use strict";
// Enphase Envoy driver over the gateway's own local API
// (GET /api/v1/production) - real, documented by Enphase's own local API
// (older firmware needs no auth at all). High confidence for older
// firmware; newer firmware (D7.x+) added a JWT bearer-token requirement
// obtained via an Enlighten cloud login this driver doesn't implement -
// paste a manually-obtained token into the token setting for that case.
const POLL_MS = 30000;

function create(ctx) {
  const host = ctx.config.connection.host;
  let pollHandle = null;

  async function refresh() {
    try {
      const headers = ctx.config.settings.token ? { Authorization: `Bearer ${ctx.config.settings.token}` } : {};
      const data = await fetch(`http://${host}/api/v1/production`, { headers }).then((r) => r.json());
      ctx.setState("power.now", data.wattsNow);
      ctx.setState("energy.today", data.wattHoursToday);
      ctx.setState("energy.lifetime", data.wattHoursLifetime);
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
