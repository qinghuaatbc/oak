"use strict";
// Netatmo Weather Station driver over Netatmo's own published API
// (dev.netatmo.com) - real, documented, OAuth2. Like ../nest and
// ../spotify, the first token needs an interactive browser consent step
// this driver doesn't attempt to drive itself - supply a refreshToken
// obtained once externally.
//
// Scoped to the weather station product line's read-only sensor data
// (getstationsdata) - Netatmo's separate thermostat/Energy line
// (setroomthermpoint etc., keyed by home_id/room_id rather than a simple
// device/module id) is a materially different API shape and left out of
// this first cut rather than half-implemented.
const TOKEN_URL = "https://api.netatmo.com/oauth2/token";
const API_BASE = "https://api.netatmo.com/api";
const POLL_MS = 5 * 60 * 1000;

function create(ctx) {
  let accessToken = null;
  let pollHandle = null;

  async function refreshAccessToken() {
    const { clientId, clientSecret, refreshToken } = ctx.config.settings;
    if (!refreshToken) return false;
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) {
      ctx.log(`Token refresh failed: ${data.error || res.status}`);
      return false;
    }
    accessToken = data.access_token;
    return true;
  }

  async function refresh() {
    if (!accessToken && !(await refreshAccessToken())) return;
    let res = await fetch(`${API_BASE}/getstationsdata`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (res.status === 401 && (await refreshAccessToken())) {
      res = await fetch(`${API_BASE}/getstationsdata`, { headers: { Authorization: `Bearer ${accessToken}` } });
    }
    if (!res.ok) {
      ctx.log(`Refresh failed: HTTP ${res.status}`);
      return;
    }
    const data = await res.json();
    const device = data.body && data.body.devices && data.body.devices[0];
    if (!device) return;
    const moduleId = ctx.config.settings.moduleId;
    const source = moduleId ? (device.modules || []).find((m) => m._id === moduleId) : device;
    if (!source || !source.dashboard_data) return;
    const d = source.dashboard_data;
    if (d.Temperature !== undefined) ctx.setState("sensor.temperature", d.Temperature);
    if (d.Humidity !== undefined) ctx.setState("sensor.humidity", d.Humidity);
    if (d.CO2 !== undefined) ctx.setState("sensor.co2", d.CO2);
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
