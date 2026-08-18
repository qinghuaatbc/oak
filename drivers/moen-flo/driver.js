"use strict";
// Moen Flo smart water shutoff driver over their UNOFFICIAL cloud API
// (documented by community reverse-engineering, e.g. python-flo) - same
// fragile class as ../ring/../simplisafe. Simple token login (no 2FA
// flow to worry about, unlike some others in this class).
const API_BASE = "https://api.meetflo.com/api/v1";
const API_V2_BASE = "https://api.meetflo.com/api/v2";
const POLL_MS = 60000;

function create(ctx) {
  let token = null;
  let pollHandle = null;

  ctx.onAction("login", async () => {
    try {
      const res = await fetch(`${API_BASE}/users/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: ctx.config.settings.email, password: ctx.config.settings.password }),
      });
      const data = await res.json();
      token = data.token;
      if (token) ctx.log("Logged in");
      else ctx.log(`Login failed: ${JSON.stringify(data)}`);
    } catch (err) {
      ctx.log(`Login failed: ${err.message}`);
    }
  });

  async function setValve(target) {
    if (!token) {
      ctx.log("Not logged in - run login first");
      return;
    }
    const deviceId = ctx.config.settings.deviceId;
    try {
      await fetch(`${API_V2_BASE}/devices/${deviceId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: token },
        body: JSON.stringify({ valve: { target } }),
      });
      refresh();
    } catch (err) {
      ctx.log(`setValve failed: ${err.message}`);
    }
  }
  ctx.onAction("openValve", () => setValve("open"));
  ctx.onAction("closeValve", () => setValve("closed"));

  async function refresh() {
    const deviceId = ctx.config.settings.deviceId;
    if (!token || !deviceId) return;
    try {
      const data = await fetch(`${API_V2_BASE}/devices/${deviceId}`, { headers: { Authorization: token } }).then((r) => r.json());
      if (data.valve) ctx.setState("valve.open", data.valve.lastKnown === "open");
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
