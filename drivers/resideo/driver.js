"use strict";
// Resideo (Honeywell Home) thermostat driver over their own published API
// (developer.honeywellhome.com) - real, official, OAuth2 PLUS an API
// consumer key required as a query param on every call in addition to
// the Bearer token, a real quirk of this specific API (not a mistake
// here) - confirmed consistently across community documentation of it.
// Same refresh-token-only pattern as this project's other OAuth2 drivers.
const TOKEN_URL = "https://api.honeywell.com/oauth2/token";
const API_BASE = "https://api.honeywell.com/v2";
const POLL_MS = 5 * 60 * 1000;

function create(ctx) {
  let accessToken = null;
  let pollHandle = null;

  async function refreshAccessToken() {
    const { consumerKey, consumerSecret, refreshToken } = ctx.config.settings;
    if (!refreshToken) return false;
    const basic = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) {
      ctx.log(`Token refresh failed: ${data.error || res.status}`);
      return false;
    }
    accessToken = data.access_token;
    return true;
  }

  function thermostatUrl() {
    const { deviceId, locationId, consumerKey } = ctx.config.settings;
    return `${API_BASE}/devices/thermostats/${deviceId}?apikey=${encodeURIComponent(consumerKey)}&locationId=${encodeURIComponent(locationId)}`;
  }

  async function api(opts) {
    if (!accessToken && !(await refreshAccessToken())) return null;
    function request() {
      return fetch(thermostatUrl(), { ...opts, headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...(opts && opts.headers) } });
    }
    let res = await request();
    if (res.status === 401 && (await refreshAccessToken())) res = await request();
    if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
    return res.status === 204 ? null : res.json();
  }

  async function setThermostat(partial) {
    try {
      const current = await api();
      await api({
        method: "POST",
        body: JSON.stringify({
          mode: current.changeableValues.mode,
          heatSetpoint: current.changeableValues.heatSetpoint,
          coolSetpoint: current.changeableValues.coolSetpoint,
          thermostatSetpointStatus: "TemporaryHold",
          ...partial,
        }),
      });
      refresh();
    } catch (err) {
      ctx.log(`Command failed: ${err.message}`);
    }
  }

  ctx.onAction("setMode", ({ mode }) => setThermostat({ mode }));
  ctx.onAction("setHeatSetpoint", ({ value }) => setThermostat({ heatSetpoint: value }));
  ctx.onAction("setCoolSetpoint", ({ value }) => setThermostat({ coolSetpoint: value }));

  async function refresh() {
    if (!ctx.config.settings.deviceId) return;
    try {
      const data = await api();
      if (!data) return;
      ctx.setState("climate.currentTemp", data.indoorTemperature);
      const cv = data.changeableValues || {};
      ctx.setState("climate.mode", cv.mode);
      ctx.setState("climate.heatSetpoint", cv.heatSetpoint);
      ctx.setState("climate.coolSetpoint", cv.coolSetpoint);
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
