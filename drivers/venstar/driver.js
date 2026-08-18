"use strict";
// Venstar thermostat driver over their own OFFICIALLY published local API
// (venstar.com publishes a "Local API" PDF for Colortouch/Explorer Mini
// models) - real, official, high confidence.
const MODES = { off: 0, heat: 1, cool: 2, auto: 3 };
const MODE_NAMES = ["off", "heat", "cool", "auto"];
const POLL_MS = 60000;

function create(ctx) {
  const host = ctx.config.connection.host;
  const base = `http://${host}`;
  let pollHandle = null;
  let lastInfo = {};

  async function control(fields) {
    try {
      await fetch(`${base}/control`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
      refresh();
    } catch (err) {
      ctx.log(`Command failed: ${err.message}`);
    }
  }
  ctx.onAction("setMode", ({ mode }) => control({ mode: String(MODES[mode] !== undefined ? MODES[mode] : 0) }));
  ctx.onAction("setHeatSetpoint", ({ value }) => control({ heattemp: String(value), cooltemp: String(lastInfo.cooltemp || value + 4) }));
  ctx.onAction("setCoolSetpoint", ({ value }) => control({ heattemp: String(lastInfo.heattemp || value - 4), cooltemp: String(value) }));

  async function refresh() {
    try {
      const info = await fetch(`${base}/query/info`).then((r) => r.json());
      lastInfo = info;
      ctx.setState("climate.currentTemp", info.spacetemp);
      ctx.setState("climate.mode", MODE_NAMES[info.mode] || "off");
      ctx.setState("climate.heatSetpoint", info.heattemp);
      ctx.setState("climate.coolSetpoint", info.cooltemp);
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
