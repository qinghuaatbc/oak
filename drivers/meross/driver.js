"use strict";
// Meross driver over their UNOFFICIAL cloud HTTP API (Meross has never
// published a public API - this is reverse-engineered, documented by the
// meross_iot community library). LOWER confidence than most drivers here:
// Meross's API wraps every request's params in a base64 JSON blob and an
// MD5 signature (sign = MD5(loginKey + timestamp + nonce + paramsBase64))
// using a fixed app secret Meross's own app embeds - recalled from
// meross_iot's source with only moderate confidence, since this class of
// embedded-secret API is exactly the kind of thing that quietly breaks
// when a vendor rotates it. A signing failure surfaces as a clean auth
// error from Meross's servers (logged), not a hang, so the failure mode
// here is safe even if this constant is stale - same reasoning already
// applied to ../myq's app-id header.
const crypto = require("crypto");

const API_BASE = "https://iot.meross.com/v1";
const APP_SECRET = "23x17ahWarFH6w29"; // Meross's own app's embedded secret, per meross_iot

function md5(str) {
  return crypto.createHash("md5").update(str).digest("hex");
}
function nonce() {
  return crypto.randomBytes(8).toString("hex");
}
function signedBody(params) {
  const timestamp = Date.now();
  const nonceStr = nonce();
  const dataBase64 = Buffer.from(JSON.stringify(params)).toString("base64");
  const sign = md5(APP_SECRET + timestamp + nonceStr + dataBase64);
  return { timestamp, nonce: nonceStr, sign, params: dataBase64 };
}

function create(ctx) {
  let token = null;
  let key = null;
  let userId = null;

  async function call(path, params) {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...(token ? { Authorization: `Basic ${token}` } : {}) },
      body: new URLSearchParams(signedBody(params || {})),
    });
    const data = await res.json();
    if (data.apiStatus !== 0) throw new Error(data.info || `Meross API error ${data.apiStatus}`);
    return data.data;
  }

  async function login() {
    const data = await call("/Auth/signIn", { email: ctx.config.settings.email, password: ctx.config.settings.password });
    token = data.token;
    key = data.key;
    userId = data.userid;
    return true;
  }

  async function setToggle(on) {
    if (!token && !(await login().catch((err) => ctx.log(`Login failed: ${err.message}`)))) return;
    const uuid = ctx.config.settings.deviceUuid;
    const channel = ctx.config.settings.channel || 0;
    try {
      await call(`/Device/${uuid}/publish`, {
        header: { messageId: nonce(), method: "SET", namespace: "Appliance.Control.ToggleX", payloadVersion: 1, sign: "", timestamp: Date.now() },
        payload: { togglex: { channel, onoff: on ? 1 : 0 } },
      });
    } catch (err) {
      ctx.log(`Command failed: ${err.message}`);
    }
  }
  ctx.onAction("turnOn", () => setToggle(true));
  ctx.onAction("turnOff", () => setToggle(false));

  ctx.onAction("discoverDevices", async () => {
    if (!token && !(await login().catch((err) => ctx.log(`Login failed: ${err.message}`)))) return;
    try {
      const devices = await call("/Device/devList", {});
      const list = (devices || []).map((d) => ({ uuid: d.uuid, name: d.devName }));
      ctx.setState("discovery.devices", JSON.stringify(list));
    } catch (err) {
      ctx.log(`discoverDevices failed: ${err.message}`);
    }
  });

  return {
    onConnect() {},
    onDisconnect() {},
  };
}

module.exports = { create };
