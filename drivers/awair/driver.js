"use strict";
// Awair air quality monitor driver over its own published local API
// (support.getawair.com documents "Local API" - must be enabled per
// device in the Awair app first) - a real, documented, no-auth-needed
// local HTTP endpoint, high confidence.
const POLL_MS = 30000;

function create(ctx) {
  const host = ctx.config.connection.host;

  let pollHandle = null;

  async function refresh() {
    try {
      const data = await fetch(`http://${host}/air-data/latest`).then((r) => r.json());
      ctx.setState("air.score", data.score);
      ctx.setState("air.temp", data.temp);
      ctx.setState("air.humidity", data.humid);
      ctx.setState("air.co2", data.co2);
      ctx.setState("air.voc", data.voc);
      if (data.pm25 !== undefined) ctx.setState("air.pm25", data.pm25);
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
