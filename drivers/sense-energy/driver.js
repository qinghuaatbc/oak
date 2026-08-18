"use strict";
// Sense Energy Monitor driver over their UNOFFICIAL cloud API
// (documented by the sense_energy community library) - login via a
// plain REST call, then a live realtime feed over WebSocket. Moderate-
// high confidence - simpler auth than ../emporia-vue (no AWS Cognito
// hop), just Sense's own token endpoint.
const AUTH_URL = "https://api.sense.com/apiservice/api/v1/authenticate";

function create(ctx) {
  let ws = null;

  ctx.onAction("login", async () => {
    try {
      const res = await fetch(AUTH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email: ctx.config.settings.email, password: ctx.config.settings.password }),
      });
      const data = await res.json();
      const token = data.access_token;
      const monitorId = data.monitors && data.monitors[0] && data.monitors[0].id;
      if (!token || !monitorId) {
        ctx.log(`Login failed: ${JSON.stringify(data)}`);
        return;
      }
      connectRealtime(token, monitorId);
    } catch (err) {
      ctx.log(`Login failed: ${err.message}`);
    }
  });

  function connectRealtime(token, monitorId) {
    if (ws) ws.terminate();
    ws = new WebSocket(`wss://clientrt.sense.com/monitors/${monitorId}/realtimefeed?access_token=${token}`);
    ws.on("open", () => ctx.log("Realtime feed connected"));
    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      const payload = msg.payload;
      if (!payload) return;
      if (payload.w !== undefined) ctx.setState("power.usageWatts", payload.w);
      if (payload.solar_w !== undefined) ctx.setState("power.solarWatts", payload.solar_w);
    });
    ws.on("error", (err) => ctx.log(`Realtime feed error: ${err.message}`));
  }

  return {
    onConnect() {},
    onDisconnect() {
      if (ws) ws.terminate();
      ws = null;
    },
  };
}

module.exports = { create };
