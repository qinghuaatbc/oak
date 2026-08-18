"use strict";
// WeatherFlow Tempest driver over their own published REST API
// (weatherflow.github.io/Tempest/api) - real, official, high confidence.
const API_BASE = "https://swd.weatherflow.com/swd/rest";
const POLL_MS = 5 * 60 * 1000;

function create(ctx) {
  let pollHandle = null;

  ctx.onAction("discoverStations", async () => {
    try {
      const data = await fetch(`${API_BASE}/stations?token=${ctx.config.settings.token}`).then((r) => r.json());
      const stations = (data.stations || []).map((s) => ({ id: s.station_id, name: s.name }));
      ctx.setState("discovery.stations", JSON.stringify(stations));
    } catch (err) {
      ctx.log(`discoverStations failed: ${err.message}`);
    }
  });

  async function refresh() {
    const stationId = ctx.config.settings.stationId;
    if (!stationId) return;
    try {
      const data = await fetch(`${API_BASE}/observations/station/${stationId}?token=${ctx.config.settings.token}`).then((r) => r.json());
      const obs = data.obs && data.obs[0];
      if (!obs) return;
      ctx.setState("weather.tempC", obs.air_temperature);
      ctx.setState("weather.humidity", obs.relative_humidity);
      ctx.setState("weather.windAvgMps", obs.wind_avg);
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
