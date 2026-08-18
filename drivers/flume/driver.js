"use strict";
// Flume water monitor driver over their own published REST API
// (developer.flumetech.com) - real, official. Unlike most cloud drivers
// in this project, Flume's documented OAuth2 flow genuinely supports a
// plain password grant (client_id/secret from their developer portal
// plus the user's own username/password) - no interactive consent step
// needed, so no refresh-token-only workaround required here.
const TOKEN_URL = "https://api.flumewater.com/oauth/token";
const API_BASE = "https://api.flumewater.com";
const POLL_MS = 60000;

function create(ctx) {
  let accessToken = null;
  let userId = null;
  let pollHandle = null;

  async function login() {
    const { clientId, clientSecret, username, password } = ctx.config.settings;
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "password", client_id: clientId, client_secret: clientSecret, username, password }),
    });
    const data = await res.json();
    const token = data.data && data.data[0] && data.data[0].access_token;
    if (!token) return false;
    accessToken = token;
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString("utf8"));
    userId = payload.user_id;
    return true;
  }

  async function api(path) {
    if (!accessToken && !(await login().catch((err) => ctx.log(`Login failed: ${err.message}`)))) return null;
    const res = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  ctx.onAction("discoverDevices", async () => {
    try {
      const data = await api(`/users/${userId}/devices`);
      const devices = ((data && data.data) || []).filter((d) => d.type === 2).map((d) => ({ id: d.id, name: d.location_name }));
      ctx.setState("discovery.devices", JSON.stringify(devices));
    } catch (err) {
      ctx.log(`discoverDevices failed: ${err.message}`);
    }
  });

  async function refresh() {
    const deviceId = ctx.config.settings.deviceId;
    if (!deviceId) return;
    try {
      const res = await fetch(`${API_BASE}/users/${userId}/devices/${deviceId}/query`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ queries: [{ request_id: "cur", bucket: "MIN", since_datetime: new Date(Date.now() - 60000).toISOString().slice(0, 19), operation: "SUM" }] }),
      });
      const data = await res.json();
      const points = data.data && data.data[0] && data.data[0].cur;
      if (points && points[0]) ctx.setState("water.currentFlowRate", points[0].value);
    } catch (err) {
      ctx.log(`Refresh failed: ${err.message}`);
    }
  }
  ctx.onAction("refresh", () => refresh());

  return {
    onConnect() {
      pollHandle = ctx.clock.every(POLL_MS, refresh);
    },
    onDisconnect() {
      if (pollHandle) pollHandle.cancel();
    },
  };
}

module.exports = { create };
