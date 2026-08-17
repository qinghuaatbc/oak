"use strict";
// Home Connect driver over Bosch/Siemens's own published OAuth2 API
// (developer.home-connect.com) - real, official, extensively documented.
// Same refresh-token-only pattern as ../nest/../spotify/../netatmo since
// the first token needs an interactive consent step Oak can't drive
// itself.
const TOKEN_URL = "https://api.home-connect.com/security/oauth/token";
const API_BASE = "https://api.home-connect.com/api/homeappliances";
const POLL_MS = 60000;

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
      ctx.log(`Token refresh failed: ${data.error_description || res.status}`);
      return false;
    }
    accessToken = data.access_token;
    return true;
  }

  async function api(path, opts) {
    if (!accessToken && !(await refreshAccessToken())) return null;
    function request() {
      return fetch(`${API_BASE}${path}`, {
        ...opts,
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/vnd.bsh.sdk.v1+json", ...(opts && opts.headers) },
      });
    }
    let res = await request();
    if (res.status === 401 && (await refreshAccessToken())) res = await request();
    if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
    return res.status === 204 ? null : res.json();
  }

  ctx.onAction("turnOn", async () => {
    const haId = ctx.config.settings.applianceId;
    try {
      await api(`/${haId}/settings/BSH.Common.Setting.PowerState`, { method: "PUT", body: JSON.stringify({ data: { key: "BSH.Common.Setting.PowerState", value: "BSH.Common.EnumType.PowerState.On" } }) });
      refresh();
    } catch (err) {
      ctx.log(`turnOn failed: ${err.message}`);
    }
  });
  ctx.onAction("turnOff", async () => {
    const haId = ctx.config.settings.applianceId;
    try {
      await api(`/${haId}/settings/BSH.Common.Setting.PowerState`, { method: "PUT", body: JSON.stringify({ data: { key: "BSH.Common.Setting.PowerState", value: "BSH.Common.EnumType.PowerState.Standby" } }) });
      refresh();
    } catch (err) {
      ctx.log(`turnOff failed: ${err.message}`);
    }
  });
  ctx.onAction("startProgram", async ({ programKey }) => {
    const haId = ctx.config.settings.applianceId;
    try {
      await api(`/${haId}/programs/active`, { method: "PUT", body: JSON.stringify({ data: { key: programKey } }) });
      refresh();
    } catch (err) {
      ctx.log(`startProgram failed: ${err.message}`);
    }
  });
  ctx.onAction("stopProgram", async () => {
    const haId = ctx.config.settings.applianceId;
    try {
      await api(`/${haId}/programs/active`, { method: "DELETE" });
      refresh();
    } catch (err) {
      ctx.log(`stopProgram failed: ${err.message}`);
    }
  });

  ctx.onAction("discoverAppliances", async () => {
    try {
      const data = await api("");
      const appliances = ((data && data.data && data.data.homeappliances) || []).map((a) => ({ id: a.haId, name: a.name, type: a.type }));
      ctx.setState("discovery.appliances", JSON.stringify(appliances));
    } catch (err) {
      ctx.log(`discoverAppliances failed: ${err.message}`);
    }
  });

  async function refresh() {
    const haId = ctx.config.settings.applianceId;
    if (!haId) return;
    try {
      const data = await api(`/${haId}/status`);
      const items = (data && data.data && data.data.status) || [];
      const power = items.find((s) => s.key === "BSH.Common.Status.OperationState");
      const door = items.find((s) => s.key === "BSH.Common.Status.DoorState");
      if (power) ctx.setState("appliance.powerState", power.value);
      if (door) ctx.setState("appliance.doorState", door.value);
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
