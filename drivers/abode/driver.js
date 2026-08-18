"use strict";
// Abode Security driver over their UNOFFICIAL cloud API (no public docs
// - documented by the abodepy community library), same fragile class as
// ../ring/../myq/../august/../simplisafe. Session-cookie based auth
// (login once, reuse the token) rather than OAuth.
const API_BASE = "https://my.goabode.com/api";
const POLL_MS = 60000;

function create(ctx) {
  let token = null;
  let pollHandle = null;

  ctx.onAction("login", async () => {
    try {
      const res = await fetch(`${API_BASE}/auth2/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: ctx.config.settings.email, password: ctx.config.settings.password }),
      });
      const data = await res.json();
      if (!res.ok || !data.token) {
        ctx.log(`Login failed: ${JSON.stringify(data)}`);
        return;
      }
      token = data.token;
      ctx.log("Logged in");
    } catch (err) {
      ctx.log(`Login failed: ${err.message}`);
    }
  });

  async function setMode(mode) {
    if (!token) {
      ctx.log("Not logged in - run login first");
      return;
    }
    try {
      await fetch(`${API_BASE}/v1/panel`, { method: "PUT", headers: { "Content-Type": "application/json", ABODE_SESSION: token }, body: JSON.stringify({ area: "1", mode }) });
      refresh();
    } catch (err) {
      ctx.log(`${mode} failed: ${err.message}`);
    }
  }
  ctx.onAction("armAway", () => setMode("away"));
  ctx.onAction("armHome", () => setMode("home"));
  ctx.onAction("disarm", () => setMode("standby"));

  async function refresh() {
    if (!token) return;
    try {
      const data = await fetch(`${API_BASE}/v1/panel`, { headers: { ABODE_SESSION: token } }).then((r) => r.json());
      if (data.mode) ctx.setState("panel.mode", data.mode.area_1);
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
