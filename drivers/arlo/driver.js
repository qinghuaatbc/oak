"use strict";
// Arlo driver over their UNOFFICIAL cloud API - no public API, and
// genuinely one of the more involved ones to reverse-engineer (documented
// by the pyaarlo community library): real-time state normally comes
// through a server-sent-events stream this driver does NOT implement
// (scoped out for the same reason as Konnected's webhook push - added
// complexity without a clear win for a first cut), using on-demand polling
// of the device list instead. Login requires MFA (email/SMS/push code),
// same two-step login()/completeLogin() pattern as this project's other
// 2FA-gated drivers (ring, eero, august). Same fragile/unofficial class as
// those - treat this as more likely to need adjustment than most drivers
// here.
const API_BASE = "https://myapi.arlo.com/hmsweb";
const POLL_MS = 5 * 60 * 1000;

function create(ctx) {
  let token = null;
  let factorId = null;
  let pollHandle = null;

  ctx.onAction("login", async () => {
    try {
      const res = await fetch(`${API_BASE}/login/v2`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: ctx.config.settings.email, password: ctx.config.settings.password }),
      });
      const data = await res.json();
      const authInfo = data.data;
      if (authInfo && authInfo.authCompleted) {
        token = authInfo.token;
        ctx.log("Logged in (no MFA required)");
        return;
      }
      factorId = authInfo && authInfo.factorId;
      if (factorId) {
        await fetch(`${API_BASE}/login/v2/mfa/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ factorId }) });
        ctx.log("MFA code sent - fill in mfaCode and run completeLogin");
        ctx.emitEvent("mfaRequired", {});
      } else {
        ctx.log(`Login failed: ${JSON.stringify(data)}`);
      }
    } catch (err) {
      ctx.log(`Login failed: ${err.message}`);
    }
  });

  ctx.onAction("completeLogin", async () => {
    if (!factorId) {
      ctx.log("No login in progress - run login first");
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/login/v2/mfa/validate/${factorId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: ctx.config.settings.mfaCode }),
      });
      const data = await res.json();
      token = data.data && data.data.token;
      if (token) ctx.log("Logged in");
      else ctx.log(`MFA validation failed: ${JSON.stringify(data)}`);
    } catch (err) {
      ctx.log(`completeLogin failed: ${err.message}`);
    }
  });

  ctx.onAction("discoverDevices", async () => {
    if (!token) {
      ctx.log("Not logged in - run login first");
      return;
    }
    try {
      const data = await fetch(`${API_BASE}/users/devices`, { headers: { Authorization: token } }).then((r) => r.json());
      const devices = (data.data || []).map((d) => ({ id: d.deviceId, name: d.deviceName, type: d.deviceType }));
      ctx.setState("discovery.devices", JSON.stringify(devices));
    } catch (err) {
      ctx.log(`discoverDevices failed: ${err.message}`);
    }
  });

  async function refresh() {
    const deviceId = ctx.config.settings.deviceId;
    if (!token || !deviceId) return;
    try {
      const data = await fetch(`${API_BASE}/users/devices`, { headers: { Authorization: token } }).then((r) => r.json());
      const device = (data.data || []).find((d) => d.deviceId === deviceId);
      if (device && device.properties && device.properties.batteryLevel !== undefined) {
        ctx.setState("camera.batteryPercent", device.properties.batteryLevel);
      }
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
