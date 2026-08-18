"use strict";
// Elgato Key Light driver over its own local HTTP API (Elgato's "Control
// Center" local API, well documented via community tools like
// elgato-key-light-control - Elgato itself doesn't publish a formal spec
// but this has been completely stable for years), high confidence.
const POLL_MS = 30000;

function create(ctx) {
  const host = ctx.config.connection.host;
  const port = ctx.config.connection.port || 9123;
  const base = `http://${host}:${port}/elgato/lights`;
  let pollHandle = null;

  async function setLight(fields) {
    try {
      await fetch(base, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ numberOfLights: 1, lights: [fields] }) });
      refresh();
    } catch (err) {
      ctx.log(`Command failed: ${err.message}`);
    }
  }
  ctx.onAction("turnOn", () => setLight({ on: 1 }));
  ctx.onAction("turnOff", () => setLight({ on: 0 }));
  ctx.onAction("setBrightness", ({ value }) => setLight({ on: 1, brightness: Math.max(0, Math.min(100, Math.round(value))) }));

  async function refresh() {
    try {
      const data = await fetch(base).then((r) => r.json());
      const light = data.lights && data.lights[0];
      if (!light) return;
      ctx.setState("light.on", Boolean(light.on));
      ctx.setState("light.brightness", light.brightness);
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
