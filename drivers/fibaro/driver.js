"use strict";
// Fibaro Home Center driver over their own published local REST API
// (Fibaro documents this for HC2/HC3 integrators) - real, documented,
// high confidence. HTTP Basic auth using a Home Center user account.
const POLL_MS = 30000;

function create(ctx) {
  const host = ctx.config.connection.host;
  const base = `http://${host}/api`;
  let pollHandle = null;

  function headers() {
    const { username, password } = ctx.config.settings;
    return { Authorization: `Basic ${Buffer.from(`${username}:${password || ""}`).toString("base64")}` };
  }
  async function callAction(name, args) {
    const deviceId = ctx.config.settings.deviceId;
    const query = new URLSearchParams({ deviceID: deviceId, name });
    if (args) query.set("arg1", String(args));
    try {
      await fetch(`${base}/callAction?${query.toString()}`, { headers: headers() });
      refresh();
    } catch (err) {
      ctx.log(`${name} failed: ${err.message}`);
    }
  }
  ctx.onAction("turnOn", () => callAction("turnOn"));
  ctx.onAction("turnOff", () => callAction("turnOff"));
  ctx.onAction("setValue", ({ value }) => callAction("setValue", Math.max(0, Math.min(100, Math.round(value)))));

  async function refresh() {
    const deviceId = ctx.config.settings.deviceId;
    if (!deviceId) return;
    try {
      const data = await fetch(`${base}/devices/${deviceId}`, { headers: headers() }).then((r) => r.json());
      const value = data.properties && data.properties.value;
      if (value !== undefined) {
        ctx.setState("device.on", value === "true" || value === true || Number(value) > 0);
        ctx.setState("device.value", Number(value));
      }
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
