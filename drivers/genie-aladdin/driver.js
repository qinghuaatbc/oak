"use strict";
// Genie Aladdin Connect garage door driver - LOWER CONFIDENCE, explicitly:
// this is a 100% undocumented/reverse-engineered cloud API (no official
// public docs exist), sourced from reading the actual Python client
// (shoejosh/aladdin-connect, itself reverse-engineered from the Android
// app) against an AWS API Gateway endpoint that is internal to that app,
// not a published partner API. The community has reported Genie changing
// this API before (toward OAuth2 + websocket, ~Jan 2024) - treat this as
// a snapshot that may already be stale, and verify against a current
// library (e.g. mkmer/AIOAladdinConnect) before trusting it. Matches this
// project's existing precedent for lower-confidence reverse-engineered
// cloud drivers (ring, simplisafe) rather than being uniquely risky.
const BASE_URL = "https://pxdqkls7aj.execute-api.us-east-1.amazonaws.com/Android";
const API_KEY = "fkowarQ0dX9Gj1cbB9Xkx1yXZkd6bzVn5x24sECW";

const STATUS_MAP = { 0: "unknown", 1: "open", 2: "opening", 3: "timeout_opening", 4: "closed", 5: "closing", 6: "timeout_closing", 7: "not_configured" };

function create(ctx) {
  let accessToken = null;

  async function login() {
    const { username, password } = ctx.config.settings;
    const body = new URLSearchParams({
      grant_type: "password", client_id: "1000", brand: "ALADDIN",
      username: username || "", password: Buffer.from(password || "").toString("base64"),
      platform: "platform", model: "oak", app_version: "5.25", build_number: "2038", os_version: "12.0.0",
    });
    const res = await fetch(`${BASE_URL}/oauth/token`, {
      method: "POST",
      headers: { "X-Api-Key": API_KEY, "Content-Type": "application/x-www-form-urlencoded", BundleName: "com.geniecompany.AladdinConnect" },
      body: body.toString(),
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) {
      ctx.log(`Login failed: ${data.error_description || res.status}`);
      return false;
    }
    accessToken = data.access_token;
    return true;
  }

  async function api(path, options) {
    if (!accessToken && !(await login())) return null;
    const res = await fetch(`${BASE_URL}${path}`, { ...options, headers: { ...(options && options.headers), Authorization: `Bearer ${accessToken}`, "X-Api-Key": API_KEY } });
    if (res.status === 401) {
      accessToken = null;
      if (!(await login())) return null;
      return api(path, options);
    }
    return res.ok ? res.json() : null;
  }

  async function sendCommand(commandKey) {
    try {
      const { deviceId, doorNumber } = ctx.config.settings;
      await api(`/devices/${deviceId}/door/${doorNumber || 1}/command`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command_key: commandKey }) });
    } catch (err) {
      ctx.log(`${commandKey} failed: ${err.message}`);
    }
  }

  ctx.onAction("open", () => sendCommand("OpenDoor"));
  ctx.onAction("close", () => sendCommand("CloseDoor"));
  ctx.onAction("discoverDevices", async () => {
    try {
      const data = await api("/configuration");
      const devices = (data && data.devices) || [];
      ctx.setState("discovery.devices", JSON.stringify(devices.map((d) => ({ id: d.id, name: d.name, doors: (d.doors || []).map((door) => door.id) }))));
    } catch (err) {
      ctx.log(`discoverDevices failed: ${err.message}`);
    }
  });

  async function refresh() {
    try {
      const { deviceId, doorNumber } = ctx.config.settings;
      if (!deviceId) return;
      const data = await api("/configuration");
      const device = data && data.devices && data.devices.find((d) => String(d.id) === String(deviceId));
      const door = device && (device.doors || []).find((d) => String(d.id) === String(doorNumber || 1));
      if (door) ctx.setState("door.status", STATUS_MAP[door.status] || "unknown");
    } catch (err) {
      ctx.log(`Refresh failed: ${err.message}`);
    }
  }

  let pollTimer = null;

  return {
    onConnect() {
      refresh();
      pollTimer = ctx.clock.every(60000, refresh);
    },
    onDisconnect() {
      if (pollTimer) pollTimer.cancel();
    },
  };
}

module.exports = { create };
