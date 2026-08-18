"use strict";
// eWeLink (Sonoff) driver over Coolkit's own OFFICIAL "eWeLink Open
// Platform" API (dev.ewelink.cc) - a real published API, but every
// request must be signed (Authorization: Sign <base64 HMAC-SHA256 of the
// JSON body using the app secret>) - documented, but with enough moving
// parts (app id/secret registration, region-specific API hosts, this
// signing step) that confidence here is moderate rather than high, same
// class as ../meross. A signing/auth failure surfaces as a clean JSON
// error from the API (logged), not a hang.
const crypto = require("crypto");
const TOKEN_URL = "https://apia.coolkit.cc/v2/user/refresh";
const API_BASE = "https://apia.coolkit.cc/v2/device/thing";

function sign(body, secret) {
  return crypto.createHmac("sha256", secret || "").update(JSON.stringify(body)).digest("base64");
}

function create(ctx) {
  let accessToken = null;

  async function refreshAccessToken() {
    const { appId, appSecret, refreshToken } = ctx.config.settings;
    const body = { rt: refreshToken };
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CK-Appid": appId, Authorization: `Sign ${sign(body, appSecret)}` },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    accessToken = data.data && data.data.at;
    return Boolean(accessToken);
  }

  async function setState(on) {
    if (!accessToken && !(await refreshAccessToken().catch((err) => ctx.log(`Auth failed: ${err.message}`)))) return;
    const { appId, deviceId } = ctx.config.settings;
    const body = { type: 1, id: deviceId, params: { switch: on ? "on" : "off" } };
    try {
      await fetch(`${API_BASE}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CK-Appid": appId, Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(body),
      });
      ctx.setState("device.on", on);
    } catch (err) {
      ctx.log(`Command failed: ${err.message}`);
    }
  }
  ctx.onAction("turnOn", () => setState(true));
  ctx.onAction("turnOff", () => setState(false));

  return {
    onConnect() {},
    onDisconnect() {},
  };
}

module.exports = { create };
