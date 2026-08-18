"use strict";
// Eero driver over their UNOFFICIAL cloud API (documented by the
// eero-client community library) - same fragile class as ../ring/
// ../august/../simplisafe. Login is a two-step passwordless flow (a
// code sent via SMS/email), same login()/completeLogin() pattern as
// this project's other 2FA-style drivers.
const API_BASE = "https://api-user.e2ro.com/2.2";
const POLL_MS = 60000;

function create(ctx) {
  let sessionToken = null;
  let pollHandle = null;

  ctx.onAction("login", async () => {
    try {
      const res = await fetch(`${API_BASE}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ login: ctx.config.settings.loginIdentifier }),
      });
      const data = await res.json();
      sessionToken = data.data && data.data.user_token;
      if (sessionToken) {
        ctx.log("Verification code sent - fill in verificationCode and run completeLogin");
        ctx.emitEvent("verificationRequired", {});
      } else {
        ctx.log(`Login failed: ${JSON.stringify(data)}`);
      }
    } catch (err) {
      ctx.log(`Login failed: ${err.message}`);
    }
  });

  ctx.onAction("completeLogin", async () => {
    if (!sessionToken) {
      ctx.log("No login in progress - run login first");
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/login/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: `s=${sessionToken}` },
        body: JSON.stringify({ code: ctx.config.settings.verificationCode }),
      });
      if (res.ok) ctx.log("Logged in");
      else ctx.log(`Verification failed: HTTP ${res.status}`);
    } catch (err) {
      ctx.log(`completeLogin failed: ${err.message}`);
    }
  });

  async function refresh() {
    const networkId = ctx.config.settings.networkId;
    if (!sessionToken || !networkId) return;
    try {
      const data = await fetch(`${API_BASE}/networks/${networkId}/devices`, { headers: { Cookie: `s=${sessionToken}` } }).then((r) => r.json());
      const clients = data.data || [];
      ctx.setState("clients.count", clients.filter((c) => c.connected).length);
      const targetMac = (ctx.config.settings.clientMac || "").toLowerCase();
      if (targetMac) ctx.setState("client.online", clients.some((c) => (c.mac || "").toLowerCase() === targetMac && c.connected));
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
