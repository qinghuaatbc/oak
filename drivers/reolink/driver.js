"use strict";
// Reolink camera driver over their own published local CGI API (Reolink
// distributes an "API User Guide" PDF for developers/integrators) - real,
// documented, high confidence. Uses per-request username/password query
// params (which Reolink's API supports directly) rather than the
// separate Login-for-a-token flow, to avoid this driver needing its own
// token-refresh lifecycle for what's otherwise a simple stateless API.
const POLL_MS = 20000;

function create(ctx) {
  const host = ctx.config.connection.host;
  const port = ctx.config.connection.port || 80;
  const base = `http://${host}:${port}/cgi-bin/api.cgi`;

  let pollHandle = null;

  async function call(cmd, param) {
    const { username, password } = ctx.config.settings;
    const url = `${base}?cmd=${cmd}&user=${encodeURIComponent(username || "admin")}&password=${encodeURIComponent(password || "")}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ cmd, action: 0, param: param || {} }]),
    });
    const data = await res.json();
    const first = Array.isArray(data) ? data[0] : data;
    if (first && first.error) throw new Error(first.error.detail || "Reolink API error");
    return first && first.value;
  }

  ctx.onAction("ptzMove", async ({ direction, speed = 32 }) => {
    const channel = ctx.config.settings.channel || 0;
    try {
      await call("PtzCtrl", { channel, op: direction, speed });
    } catch (err) {
      ctx.log(`ptzMove failed: ${err.message}`);
    }
  });
  ctx.onAction("ptzStop", async () => {
    const channel = ctx.config.settings.channel || 0;
    try {
      await call("PtzCtrl", { channel, op: "Stop" });
    } catch (err) {
      ctx.log(`ptzStop failed: ${err.message}`);
    }
  });
  ctx.onAction("setIrLights", async ({ state }) => {
    try {
      await call("SetIrLights", { IrLights: { state } });
    } catch (err) {
      ctx.log(`setIrLights failed: ${err.message}`);
    }
  });

  async function refresh() {
    const channel = ctx.config.settings.channel || 0;
    try {
      const value = await call("GetMdState", { channel });
      if (value && value.state !== undefined) ctx.setState("motion.detected", value.state === 1);
    } catch (err) {
      ctx.log(`refresh failed: ${err.message}`);
    }
  }
  ctx.onAction("refreshMotion", () => refresh());

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
