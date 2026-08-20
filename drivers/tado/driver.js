"use strict";
// Tado thermostat driver over my.tado.com's v2 API - HIGH confidence,
// verified against wmalgadey/PyTado (the actively-maintained fork behind
// Home Assistant's Tado integration). Auth specifically changed on
// 2025-03-15 from username/password to OAuth2 Device Authorization Flow -
// this driver follows the SAME "interactive one-time setup, then
// persist a refresh token" pattern already established in this project
// for ecobee's PIN-based OAuth (see ../ecobee/driver.js): startDeviceAuth
// logs a verification URL + code for the installer to visit once, then
// polls until authorized and logs the resulting refresh token for the
// installer to copy into the refreshToken setting - there's no way for
// a driver to write its own settings back, so this manual copy step is
// unavoidable, same as ecobee's.
const TOKEN_URL = "https://login.tado.com/oauth2/token";
const DEVICE_AUTH_URL = "https://login.tado.com/oauth2/device_authorize";
const API_BASE = "https://my.tado.com/api/v2";

function create(ctx) {
  let accessToken = null;
  let deviceAuthTimer = null;

  async function refreshAccessToken() {
    const { clientId, refreshToken } = ctx.config.settings;
    if (!refreshToken) return false;
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId || "" }).toString(),
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) return false;
    accessToken = data.access_token;
    if (data.refresh_token) ctx.log(`New refresh token (update the refreshToken setting): ${data.refresh_token}`);
    return true;
  }

  async function api(path, options) {
    if (!accessToken && !(await refreshAccessToken())) return null;
    const res = await fetch(`${API_BASE}${path}`, { ...options, headers: { ...(options && options.headers), Authorization: `Bearer ${accessToken}` } });
    if (res.status === 401) {
      accessToken = null;
      if (!(await refreshAccessToken())) return null;
      return api(path, options);
    }
    return res.ok ? res.json() : null;
  }

  ctx.onAction("startDeviceAuth", async () => {
    try {
      const { clientId } = ctx.config.settings;
      const res = await fetch(DEVICE_AUTH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId || "", scope: "offline_access" }).toString(),
      });
      const data = await res.json();
      if (!res.ok || !data.device_code) {
        ctx.log(`Device authorization request failed: ${JSON.stringify(data)}`);
        return;
      }
      ctx.log(`Visit ${data.verification_uri_complete || data.verification_uri} and enter code ${data.user_code} to authorize (expires in ${data.expires_in}s)`);
      ctx.emitEvent("authPending", { verificationUri: data.verification_uri, userCode: data.user_code });
      if (deviceAuthTimer) deviceAuthTimer.cancel();
      const intervalMs = (data.interval || 5) * 1000;
      deviceAuthTimer = ctx.clock.every(intervalMs, async () => {
        try {
          const tokenRes = await fetch(TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
              device_code: data.device_code,
              client_id: clientId || "",
            }).toString(),
          });
          const tokenData = await tokenRes.json();
          if (tokenData.access_token) {
            accessToken = tokenData.access_token;
            deviceAuthTimer.cancel();
            deviceAuthTimer = null;
            ctx.log(`Authorized - save this refresh token into the refreshToken setting: ${tokenData.refresh_token}`);
            ctx.emitEvent("authComplete", {});
          }
          // tokenData.error === "authorization_pending" just means keep waiting - not logged every poll to avoid spam
        } catch (err) {
          ctx.log(`Device auth poll failed: ${err.message}`);
        }
      });
    } catch (err) {
      ctx.log(`startDeviceAuth failed: ${err.message}`);
    }
  });

  ctx.onAction("setTemperature", async ({ celsius }) => {
    try {
      const { homeId, zoneId } = ctx.config.settings;
      await api(`/homes/${homeId}/zones/${zoneId}/overlay`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          setting: { type: "HEATING", power: "ON", temperature: { celsius } },
          termination: { typeSkillBasedApp: "MANUAL" },
        }),
      });
    } catch (err) {
      ctx.log(`setTemperature failed: ${err.message}`);
    }
  });
  ctx.onAction("resumeSchedule", async () => {
    try {
      const { homeId, zoneId } = ctx.config.settings;
      await api(`/homes/${homeId}/zones/${zoneId}/overlay`, { method: "DELETE" });
    } catch (err) {
      ctx.log(`resumeSchedule failed: ${err.message}`);
    }
  });

  async function refresh() {
    try {
      const { homeId, zoneId } = ctx.config.settings;
      if (!homeId || !zoneId) return;
      const state = await api(`/homes/${homeId}/zones/${zoneId}/state`);
      if (!state) return;
      const setting = state.setting;
      if (setting) {
        ctx.setState("power", setting.power === "ON");
        if (setting.temperature) ctx.setState("targetTemp", setting.temperature.celsius);
      }
      if (state.sensorDataPoints && state.sensorDataPoints.insideTemperature) {
        ctx.setState("currentTemp", state.sensorDataPoints.insideTemperature.celsius);
      }
    } catch (err) {
      ctx.log(`Refresh failed: ${err.message}`);
    }
  }
  ctx.onAction("refresh", refresh);

  let pollTimer = null;

  return {
    onConnect() {
      refresh();
      pollTimer = ctx.clock.every(60000, refresh);
    },
    onDisconnect() {
      if (pollTimer) pollTimer.cancel();
      if (deviceAuthTimer) deviceAuthTimer.cancel();
    },
  };
}

module.exports = { create };
