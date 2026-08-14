"use strict";
// OpenWeatherMap driver over their own published Current Weather API
// (openweathermap.org/current) - a fixed cloud endpoint, polled (weather
// has no push mechanism on the free tier) at a deliberately coarse
// default interval (10 min) since conditions don't meaningfully change
// faster than that and the free tier has a real per-day call budget.
const API_URL = "https://api.openweathermap.org/data/2.5/weather";
const LAT_LON_RE = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

function create(ctx) {
  const apiKey = (ctx.config.settings && ctx.config.settings.apiKey) || "";
  const location = (ctx.config.settings && ctx.config.settings.location) || "";
  const units = (ctx.config.settings && ctx.config.settings.units) || "metric";
  let pollHandle = null;
  let lastSnapshot = null;

  function buildUrl() {
    const params = new URLSearchParams({ appid: apiKey, units });
    const latLon = location.match(LAT_LON_RE);
    if (latLon) {
      params.set("lat", latLon[1]);
      params.set("lon", latLon[2]);
    } else {
      params.set("q", location);
    }
    return `${API_URL}?${params.toString()}`;
  }

  async function refresh() {
    if (!apiKey || !location) {
      ctx.log("refresh skipped: apiKey/location not configured yet");
      return;
    }
    try {
      const res = await fetch(buildUrl());
      const data = await res.json();
      if (!res.ok) {
        ctx.log("refresh failed:", data.message || `HTTP ${res.status}`);
        return;
      }
      const temperature = data.main && data.main.temp;
      const feelsLike = data.main && data.main.feels_like;
      const humidity = data.main && data.main.humidity;
      const description = (data.weather && data.weather[0] && data.weather[0].description) || "";
      const condition = (data.weather && data.weather[0] && data.weather[0].main) || "";
      const windSpeed = data.wind && data.wind.speed;
      const snapshot = JSON.stringify({ temperature, description });
      if (snapshot === lastSnapshot) return;
      lastSnapshot = snapshot;
      ctx.setState("weather.temperature", temperature);
      ctx.setState("weather.feelsLike", feelsLike);
      ctx.setState("weather.humidity", humidity);
      ctx.setState("weather.description", description);
      ctx.setState("weather.condition", condition);
      ctx.setState("weather.windSpeed", windSpeed);
      ctx.emitEvent("weatherChanged", { temperature, description });
    } catch (err) {
      ctx.log("refresh failed:", err.message);
    }
  }

  ctx.onAction("refresh", refresh);

  return {
    onConnect() {
      ctx.log("Polling OpenWeatherMap for", location || "(no location configured)");
      refresh();
      const intervalMs = (ctx.config.settings && ctx.config.settings.pollIntervalMs) || 600000;
      pollHandle = ctx.clock.every(intervalMs, refresh);
    },
    onDisconnect() {
      if (pollHandle) pollHandle.cancel();
    },
  };
}
module.exports = { create };
