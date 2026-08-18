"use strict";
// Ambient Weather driver over their own published REST API
// (ambientweather.net/api docs) - real, official, high confidence.
const API_BASE = "https://api.ambientweather.net/v1";
const POLL_MS = 5 * 60 * 1000;

function create(ctx) {
  let pollHandle = null;

  function keys() {
    const { apiKey, applicationKey } = ctx.config.settings;
    return `apiKey=${apiKey}&applicationKey=${applicationKey}`;
  }

  ctx.onAction("discoverStations", async () => {
    try {
      const data = await fetch(`${API_BASE}/devices?${keys()}`).then((r) => r.json());
      const stations = (data || []).map((d) => ({ mac: d.macAddress, name: d.info && d.info.name }));
      ctx.setState("discovery.stations", JSON.stringify(stations));
    } catch (err) {
      ctx.log(`discoverStations failed: ${err.message}`);
    }
  });

  async function refresh() {
    const mac = ctx.config.settings.macAddress;
    if (!mac) return;
    try {
      const data = await fetch(`${API_BASE}/devices/${mac}?${keys()}&limit=1`).then((r) => r.json());
      const latest = data && data[0];
      if (!latest) return;
      ctx.setState("weather.tempF", latest.tempf);
      ctx.setState("weather.humidity", latest.humidity);
      ctx.setState("weather.windSpeedMph", latest.windspeedmph);
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
