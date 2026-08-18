"use strict";
// SwitchBot driver over their own OFFICIALLY published API
// (switch-bot.github.io/docs) - real, official, high confidence,
// including the documented HMAC-SHA256 request-signing scheme.
const crypto = require("crypto");
const API_BASE = "https://api.switch-bot.com/v1.1";
const POLL_MS = 60000;

function create(ctx) {
  let pollHandle = null;

  function authHeaders() {
    const { token, secret } = ctx.config.settings;
    const t = Date.now().toString();
    const nonce = crypto.randomBytes(8).toString("hex");
    const sign = crypto.createHmac("sha256", secret || "").update(`${token}${t}${nonce}`).digest("base64");
    return { Authorization: token || "", sign, t, nonce, "Content-Type": "application/json" };
  }

  async function command(cmd, parameter) {
    const deviceId = ctx.config.settings.deviceId;
    try {
      await fetch(`${API_BASE}/devices/${deviceId}/commands`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ command: cmd, parameter: parameter || "default", commandType: "command" }),
      });
      refresh();
    } catch (err) {
      ctx.log(`${cmd} failed: ${err.message}`);
    }
  }
  ctx.onAction("turnOn", () => command("turnOn"));
  ctx.onAction("turnOff", () => command("turnOff"));
  ctx.onAction("press", () => command("press"));

  ctx.onAction("discoverDevices", async () => {
    try {
      const data = await fetch(`${API_BASE}/devices`, { headers: authHeaders() }).then((r) => r.json());
      const devices = ((data.body && data.body.deviceList) || []).map((d) => ({ id: d.deviceId, name: d.deviceName, type: d.deviceType }));
      ctx.setState("discovery.devices", JSON.stringify(devices));
    } catch (err) {
      ctx.log(`discoverDevices failed: ${err.message}`);
    }
  });

  async function refresh() {
    const deviceId = ctx.config.settings.deviceId;
    if (!deviceId) return;
    try {
      const data = await fetch(`${API_BASE}/devices/${deviceId}/status`, { headers: authHeaders() }).then((r) => r.json());
      const body = data.body;
      if (body && body.power !== undefined) ctx.setState("device.on", body.power === "on");
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
