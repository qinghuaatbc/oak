"use strict";
// SimpliSafe driver over their UNOFFICIAL cloud API - no public API,
// reverse-engineered (documented by the simplipy community library),
// same fragile/unofficial class as ../ring/../myq/../august. Login is a
// full OAuth2 PKCE flow with an interactive SimpliSafe-hosted login page
// (more involved than a plain password grant) - this driver only
// supports the refresh-token-only path (obtained once externally, same
// constraint as this project's other OAuth2 drivers) rather than
// attempting to drive that page itself.
const TOKEN_URL = "https://auth.simplisafe.com/oauth/token";
const API_BASE = "https://api.simplisafe.com/v1";
const CLIENT_ID = "42aBZ5lYrVW12jfOuu3CQROitwxg9sN5"; // SimpliSafe app's own public OAuth client id, per simplipy
const POLL_MS = 60000;

function create(ctx) {
  let accessToken = null;
  let userId = null;
  let pollHandle = null;

  async function refreshAccessToken() {
    const refreshToken = ctx.config.settings.refreshToken;
    if (!refreshToken) return false;
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLIENT_ID }),
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
      return fetch(`${API_BASE}${path}`, { ...opts, headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...(opts && opts.headers) } });
    }
    let res = await request();
    if (res.status === 401 && (await refreshAccessToken())) res = await request();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function setState(state) {
    const systemId = ctx.config.settings.systemId;
    try {
      await api(`/ss3/subscriptions/${systemId}/state/${state}`, { method: "POST" });
      refresh();
    } catch (err) {
      ctx.log(`${state} failed: ${err.message}`);
    }
  }
  ctx.onAction("armAway", () => setState("away"));
  ctx.onAction("armHome", () => setState("home"));
  ctx.onAction("disarm", () => setState("off"));

  ctx.onAction("discoverSystems", async () => {
    try {
      const me = await api("/api/authCheck");
      userId = me.userId;
      const data = await api(`/users/${userId}/subscriptions?activeOnly=true`);
      const systems = (data.subscriptions || []).map((s) => ({ id: s.sid, name: s.location && s.location.system && s.location.system.serial }));
      ctx.setState("discovery.systems", JSON.stringify(systems));
    } catch (err) {
      ctx.log(`discoverSystems failed: ${err.message}`);
    }
  });

  async function refresh() {
    const systemId = ctx.config.settings.systemId;
    if (!systemId) return;
    try {
      const data = await api(`/ss3/subscriptions/${systemId}/state`);
      if (data.state) ctx.setState("system.state", data.state);
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
