"use strict";
// Ring driver over Ring's UNOFFICIAL, private mobile-app API - Ring has
// never published a public API or SDK. This is the least reliable driver
// in this project by a real margin, worth calling out explicitly rather
// than giving it the same confidence framing as the others here:
//   - The auth flow (OAuth2 password grant against oauth.ring.com, with a
//     2fa-support/tsv-state challenge step) is recalled from how
//     community projects like ring-client-api have implemented it, not
//     verified against Ring's current behavior this session.
//   - Ring has changed this private API's endpoints/hosts before without
//     notice, and will likely do so again - if this driver stops working,
//     that is the expected failure mode for depending on an unofficial
//     API, not necessarily a bug in this code.
//   - Live video (the actual doorbell camera feed) goes over a WebRTC/SIP
//     signaling path this driver does NOT implement at all - that's a
//     real-time media negotiation, well beyond a lightweight REST driver;
//     use Ring's own app for live view, this driver is for basic
//     device/event polling only.
const OAUTH_URL = "https://oauth.ring.com/oauth/token";
const API_BASE = "https://api.ring.com/clients_api";
const POLL_MS = 60000;

function create(ctx) {
  let accessToken = null;
  let refreshToken = null;
  let pendingTwoFactor = false;
  let pollHandle = null;

  async function doLogin(extraHeaders) {
    const res = await fetch(OAUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...extraHeaders },
      body: JSON.stringify({
        grant_type: "password",
        username: ctx.config.settings.email,
        password: ctx.config.settings.password,
        client_id: "ring_official_android",
        scope: "client",
      }),
    });
    if (res.status === 412) {
      pendingTwoFactor = true;
      ctx.log("2FA code required - Ring should have sent one via SMS/email. Fill in twoFactorCode and run completeLogin.");
      ctx.emitEvent("twoFactorRequired", {});
      return;
    }
    const data = await res.json();
    if (!res.ok || !data.access_token) {
      ctx.log(`Login failed: ${data.error_description || res.status}`);
      return;
    }
    accessToken = data.access_token;
    refreshToken = data.refresh_token;
    pendingTwoFactor = false;
    ctx.log("Logged in");
    ctx.emitEvent("loggedIn", {});
  }

  ctx.onAction("login", () => doLogin({}));
  ctx.onAction("completeLogin", () => {
    if (!pendingTwoFactor) {
      ctx.log("No login in progress - run login first");
      return;
    }
    doLogin({ "2fa-support": "true", "2fa-code": ctx.config.settings.twoFactorCode || "" });
  });

  async function apiFetch(path) {
    if (!accessToken) throw new Error("not logged in");
    const res = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  ctx.onAction("discoverDevices", async () => {
    try {
      const data = await apiFetch("/ring_devices");
      const all = [...(data.doorbots || []), ...(data.stickup_cams || []), ...(data.chimes || [])].map((d) => ({
        id: d.id,
        name: d.description,
        kind: d.kind,
      }));
      ctx.setState("discovery.devices", JSON.stringify(all));
    } catch (err) {
      ctx.log(`discoverDevices failed: ${err.message}`);
    }
  });

  async function refresh() {
    const deviceId = ctx.config.settings.deviceId;
    if (!accessToken || !deviceId) return;
    try {
      const data = await apiFetch("/ring_devices");
      const all = [...(data.doorbots || []), ...(data.stickup_cams || [])];
      const device = all.find((d) => String(d.id) === String(deviceId));
      if (device && device.battery_life !== undefined) ctx.setState("device.battery", Number(device.battery_life));
    } catch (err) {
      ctx.log(`refresh failed: ${err.message}`);
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
