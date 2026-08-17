"use strict";
// Google Nest driver over Google's own published Smart Device Management
// (SDM) API (developers.google.com/nest/device-access) - the OFFICIAL
// replacement for the old "Works with Nest" program, requiring a
// one-time-paid Device Access project registration. Real, documented API
// - high confidence on the request shapes below.
//
// Auth is standard Google OAuth2, which needs an interactive browser
// consent screen for the FIRST authorization - Oak has no general OAuth
// redirect-callback infrastructure (same constraint noted in
// ../ecobee/driver.js and ../tesla/driver.js), so this driver expects a
// refreshToken obtained once through that external flow (Google's own
// "OAuth 2.0 Playground" or a small one-off script works for this) rather
// than attempting to drive the consent screen itself.
const TOKEN_URL = "https://www.googleapis.com/oauth2/v4/token";
const POLL_MS = 60000;

function create(ctx) {
  let accessToken = null;
  let pollHandle = null;

  function apiBase() {
    return `https://smartdevicemanagement.googleapis.com/v1/enterprises/${ctx.config.settings.projectId}`;
  }

  async function refreshAccessToken() {
    const { clientId, clientSecret, refreshToken } = ctx.config.settings;
    if (!refreshToken) return false;
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) {
      ctx.log(`Token refresh failed: ${data.error_description || res.status}`);
      return false;
    }
    accessToken = data.access_token;
    return true;
  }

  async function api(path, opts) {
    if (!accessToken && !(await refreshAccessToken())) return null;
    function request() {
      return fetch(`${apiBase()}${path}`, { ...opts, headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...(opts && opts.headers) } });
    }
    let res = await request();
    if (res.status === 401 && (await refreshAccessToken())) res = await request();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.status === 204 ? null : res.json();
  }

  async function executeCommand(command, params) {
    const deviceId = ctx.config.settings.deviceId;
    try {
      await api(`/devices/${deviceId}:executeCommand`, { method: "POST", body: JSON.stringify({ command, params }) });
      refresh();
    } catch (err) {
      ctx.log(`${command} failed: ${err.message}`);
    }
  }

  ctx.onAction("setMode", ({ mode }) => executeCommand("sdm.devices.commands.ThermostatMode.SetMode", { mode }));
  ctx.onAction("setHeatSetpoint", ({ value }) => executeCommand("sdm.devices.commands.ThermostatTemperatureSetpoint.SetHeat", { heatCelsius: value }));
  ctx.onAction("setCoolSetpoint", ({ value }) => executeCommand("sdm.devices.commands.ThermostatTemperatureSetpoint.SetCool", { coolCelsius: value }));

  ctx.onAction("discoverDevices", async () => {
    try {
      const data = await api("/devices");
      const devices = (data.devices || []).map((d) => ({ id: d.name.split("/").pop(), type: d.type }));
      ctx.setState("discovery.devices", JSON.stringify(devices));
    } catch (err) {
      ctx.log(`discoverDevices failed: ${err.message}`);
    }
  });

  async function refresh() {
    const deviceId = ctx.config.settings.deviceId;
    if (!deviceId) return;
    try {
      const data = await api(`/devices/${deviceId}`);
      const traits = data && data.traits;
      if (!traits) return;
      const temp = traits["sdm.devices.traits.Temperature"];
      if (temp) ctx.setState("climate.currentTemp", temp.ambientTemperatureCelsius);
      const mode = traits["sdm.devices.traits.ThermostatMode"];
      if (mode) ctx.setState("climate.mode", mode.mode);
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
