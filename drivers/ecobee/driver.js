"use strict";
// Ecobee thermostat driver over their own published REST API
// (developer.ecobee.com), fixed cloud endpoints, PIN-based OAuth2 (the
// documented flow for a headless/non-browser app: no redirect URI
// needed). Setup is a two-step manual process, since Oak has no OAuth
// callback/redirect infrastructure to complete a normal auth-code flow:
//   1. Run the "startPinAuth" action - reads back a PIN (also visible as
//      the auth.pin state) and stores the interim "code" in memory.
//   2. Within the PIN's expiry window (typically ~10 min), log into
//      ecobee.com -> My Apps -> Add Application -> enter the PIN.
//   3. Run "completePinAuth" - exchanges the code for a refresh_token,
//      logged so it can be copied into the refreshToken setting (the
//      in-memory copy does not survive an orchestrator restart, since Oak
//      driver state is not itself persisted to disk - only manifest
//      settings are).
// Temperatures in the Ecobee API are tenths of a degree F (700 = 70.0F) -
// this driver's actions/states use whole degrees F and convert at the
// boundary so a Dashboard slot doesn't have to know that quirk.
const AUTH_URL = "https://api.ecobee.com/authorize";
const TOKEN_URL = "https://api.ecobee.com/token";
const API_URL = "https://api.ecobee.com/1/thermostat";
const POLL_MS = 5 * 60 * 1000;

function create(ctx) {
  const apiKey = ctx.config.settings.apiKey || "";
  let accessToken = null;
  let pendingCode = null;
  let pollHandle = null;

  async function refreshAccessToken() {
    const refreshToken = ctx.config.settings.refreshToken;
    if (!refreshToken) return false;
    const params = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: apiKey });
    const res = await fetch(`${TOKEN_URL}?${params.toString()}`, { method: "POST" });
    const data = await res.json();
    if (!res.ok || !data.access_token) {
      ctx.log(`Token refresh failed: ${data.error_description || res.status}`);
      return false;
    }
    accessToken = data.access_token;
    if (data.refresh_token) ctx.log(`New refresh token (update the refreshToken setting): ${data.refresh_token}`);
    return true;
  }

  async function apiCall(method, body) {
    if (!accessToken && !(await refreshAccessToken())) return null;
    function request() {
      const headers = { Authorization: `Bearer ${accessToken}` };
      if (method === "GET") return fetch(`${API_URL}?json=${encodeURIComponent(JSON.stringify(body))}`, { headers });
      headers["Content-Type"] = "application/json";
      return fetch(API_URL, { method, headers, body: JSON.stringify(body) });
    }
    let res = await request();
    if (res.status === 401 && (await refreshAccessToken())) res = await request();
    return res.ok ? res.json() : null;
  }

  async function refresh() {
    // The whole body is wrapped, not just individual awaits - apiCall()
    // itself awaits refreshAccessToken() before ever making the real
    // request, so a network failure (unreachable host, DNS failure, ...)
    // can reject before any HTTP response exists to check .ok on. Without
    // this try/catch that rejection would escape refresh() uncaught,
    // since onConnect() below calls refresh() without awaiting it.
    try {
      const thermostatId = ctx.config.settings.thermostatId;
      const selection = { selectionType: thermostatId ? "thermostats" : "registered", selectionMatch: thermostatId || "", includeRuntime: true, includeSettings: true };
      const data = await apiCall("GET", { selection });
      const thermostat = data && data.thermostatList && data.thermostatList[0];
      if (!thermostat) return;
      ctx.setState("climate.currentTemp", thermostat.runtime.actualTemperature / 10);
      ctx.setState("climate.heatSetpoint", thermostat.runtime.desiredHeat / 10);
      ctx.setState("climate.coolSetpoint", thermostat.runtime.desiredCool / 10);
      ctx.setState("climate.hvacMode", thermostat.settings.hvacMode);
    } catch (err) {
      ctx.log(`Refresh failed: ${err.message}`);
    }
  }

  ctx.onAction("startPinAuth", async () => {
    const params = new URLSearchParams({ response_type: "ecobeePin", client_id: apiKey, scope: "smartWrite" });
    const res = await fetch(`${AUTH_URL}?${params.toString()}`);
    const data = await res.json();
    if (!data.ecobeePin) {
      ctx.log(`PIN request failed: ${JSON.stringify(data)}`);
      return;
    }
    pendingCode = data.code;
    ctx.setState("auth.pin", data.ecobeePin);
    ctx.emitEvent("pinReady", { pin: data.ecobeePin });
    ctx.log(`Enter this PIN at ecobee.com -> My Apps -> Add Application: ${data.ecobeePin}`);
  });

  ctx.onAction("completePinAuth", async () => {
    if (!pendingCode) {
      ctx.log("No pending PIN authorization - run startPinAuth first");
      return;
    }
    const params = new URLSearchParams({ grant_type: "ecobeePin", code: pendingCode, client_id: apiKey });
    const res = await fetch(`${TOKEN_URL}?${params.toString()}`, { method: "POST" });
    const data = await res.json();
    if (!data.access_token) {
      ctx.log(`Authorization not complete yet: ${data.error_description || JSON.stringify(data)}`);
      return;
    }
    accessToken = data.access_token;
    ctx.log(`Authorized. Refresh token (copy into the refreshToken setting to persist): ${data.refresh_token}`);
    ctx.emitEvent("authorized", {});
    refresh();
  });

  ctx.onAction("setHold", async ({ heatTemp, coolTemp }) => {
    const thermostatId = ctx.config.settings.thermostatId;
    await apiCall("POST", {
      selection: { selectionType: "thermostats", selectionMatch: thermostatId || "" },
      functions: [{ type: "setHold", params: { holdType: "nextTransition", heatHoldTemp: Math.round(heatTemp * 10), coolHoldTemp: Math.round(coolTemp * 10) } }],
    });
    refresh();
  });
  ctx.onAction("resumeProgram", async () => {
    const thermostatId = ctx.config.settings.thermostatId;
    await apiCall("POST", {
      selection: { selectionType: "thermostats", selectionMatch: thermostatId || "" },
      functions: [{ type: "resumeProgram", params: { resumeAll: false } }],
    });
    refresh();
  });
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
