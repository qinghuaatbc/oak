"use strict";
// Nanoleaf driver over their own published local HTTP API
// (forum.nanoleaf.me / openapi.nanoleaf.me) - a real documented API with
// an official developer portal, high confidence. Pairing follows
// Nanoleaf's own documented flow: hold the physical power button 5-7s
// until the panels flash, then POST /new within about 30s to receive an
// auth token - implemented here as the `pair` action so it can be
// triggered from the admin UI at the right moment rather than needing an
// external curl command.
function create(ctx) {
  const host = ctx.config.connection.host;
  const port = ctx.config.connection.port || 16021;
  const base = () => `http://${host}:${port}/api/v1/${ctx.config.settings.authToken || ""}`;

  ctx.onAction("pair", async () => {
    try {
      const res = await fetch(`http://${host}:${port}/api/v1/new`, { method: "POST" });
      const data = await res.json();
      if (data.auth_token) {
        ctx.setState("pairing.token", data.auth_token);
        ctx.log(`Paired. Copy this into the authToken setting: ${data.auth_token}`);
      } else {
        ctx.log(`Pairing failed: ${JSON.stringify(data)}`);
      }
    } catch (err) {
      ctx.log(`Pairing failed (was the power button held for 5-7s first?): ${err.message}`);
    }
  });

  async function put(path, body) {
    try {
      await fetch(`${base()}${path}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      refresh();
    } catch (err) {
      ctx.log(`Command failed: ${err.message}`);
    }
  }
  ctx.onAction("turnOn", () => put("/state", { on: { value: true } }));
  ctx.onAction("turnOff", () => put("/state", { on: { value: false } }));
  ctx.onAction("setBrightness", ({ value }) => put("/state", { brightness: { value: Math.max(0, Math.min(100, Math.round(value))), duration: 0 } }));
  ctx.onAction("setEffect", ({ name }) => put("/effects", { select: name }));

  async function refresh() {
    if (!ctx.config.settings.authToken) return;
    try {
      const res = await fetch(base());
      const data = await res.json();
      if (data.state) {
        ctx.setState("panel.on", Boolean(data.state.on && data.state.on.value));
        ctx.setState("panel.brightness", data.state.brightness && data.state.brightness.value);
      }
    } catch (err) {
      ctx.log(`Refresh failed: ${err.message}`);
    }
  }
  ctx.onAction("refresh", () => refresh());

  return {
    onConnect() {
      refresh();
    },
    onDisconnect() {},
  };
}

module.exports = { create };
