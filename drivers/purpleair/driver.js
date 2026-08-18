"use strict";
// PurpleAir driver over their own published REST API (api.purpleair.com)
// - real, official (PurpleAir moved to a required-API-key model a few
// years ago and documented it properly), high confidence.
const API_BASE = "https://api.purpleair.com/v1";
const POLL_MS = 5 * 60 * 1000;

function create(ctx) {
  let pollHandle = null;

  async function refresh() {
    const { apiKey, sensorIndex } = ctx.config.settings;
    if (!apiKey || !sensorIndex) return;
    try {
      const data = await fetch(`${API_BASE}/sensors/${sensorIndex}?fields=pm2.5,humidity,temperature`, { headers: { "X-API-Key": apiKey } }).then((r) => r.json());
      const sensor = data.sensor;
      if (!sensor) return;
      ctx.setState("air.pm25", sensor["pm2.5"]);
      ctx.setState("air.humidity", sensor.humidity);
      ctx.setState("air.temperature", sensor.temperature);
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
