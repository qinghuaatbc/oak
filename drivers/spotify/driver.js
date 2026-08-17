"use strict";
// Spotify driver over their own published Web API
// (developer.spotify.com/documentation/web-api) - a real, extensively
// documented public API, high confidence. Standard OAuth2 Authorization
// Code flow needs an interactive browser consent step for the FIRST
// token (same constraint as ../nest and ../ecobee) - this driver expects
// a refreshToken obtained once externally rather than driving that
// consent screen itself. Requires an active Spotify Connect device
// (the app open somewhere) for playback commands to have anything to
// target - that's a real Spotify API constraint, not a limitation
// specific to this driver.
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const API_BASE = "https://api.spotify.com/v1";
const POLL_MS = 15000;

function create(ctx) {
  let accessToken = null;
  let pollHandle = null;

  async function refreshAccessToken() {
    const { clientId, clientSecret, refreshToken } = ctx.config.settings;
    if (!refreshToken) return false;
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
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
    if (!res.ok && res.status !== 204 && res.status !== 202) throw new Error(`HTTP ${res.status}`);
    return res.status === 200 ? res.json() : null;
  }

  ctx.onAction("play", () => api("/me/player/play", { method: "PUT" }).then(refresh));
  ctx.onAction("pause", () => api("/me/player/pause", { method: "PUT" }).then(refresh));
  ctx.onAction("next", () => api("/me/player/next", { method: "POST" }).then(refresh));
  ctx.onAction("previous", () => api("/me/player/previous", { method: "POST" }).then(refresh));
  ctx.onAction("setVolume", ({ value }) => api(`/me/player/volume?volume_percent=${Math.max(0, Math.min(100, Math.round(value)))}`, { method: "PUT" }).then(refresh));
  ctx.onAction("playUri", ({ uri }) => api("/me/player/play", { method: "PUT", body: JSON.stringify({ context_uri: uri }) }).then(refresh));

  async function refresh() {
    try {
      const data = await api("/me/player");
      if (!data) {
        ctx.setState("playback.isPlaying", false);
        return;
      }
      ctx.setState("playback.isPlaying", Boolean(data.is_playing));
      if (data.item) {
        ctx.setState("playback.trackName", data.item.name);
        ctx.setState("playback.artistName", (data.item.artists || []).map((a) => a.name).join(", "));
      }
      if (data.device) ctx.setState("playback.volume", data.device.volume_percent);
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
