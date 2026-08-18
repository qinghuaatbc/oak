"use strict";
// Radio Thermostat (CT30/CT50/CT80, rebadged as 3M Filtrete) driver over
// its own local JSON HTTP API - not officially published, but a
// long-stable, widely-documented protocol (one of the original Home
// Assistant thermostat integrations), high confidence.
const MODES = { off: 0, heat: 1, cool: 2, auto: 3 };
const MODE_NAMES = ["off", "heat", "cool", "auto"];
const POLL_MS = 60000;

function create(ctx) {
  const host = ctx.config.connection.host;
  const base = `http://${host}/tstat`;
  let pollHandle = null;

  async function post(body) {
    try {
      await fetch(base, { method: "POST", body: JSON.stringify(body) });
      refresh();
    } catch (err) {
      ctx.log(`Command failed: ${err.message}`);
    }
  }
  ctx.onAction("setMode", ({ mode }) => post({ tmode: MODES[mode] !== undefined ? MODES[mode] : 0 }));
  ctx.onAction("setHeatSetpoint", ({ value }) => post({ t_heat: value }));
  ctx.onAction("setCoolSetpoint", ({ value }) => post({ t_cool: value }));

  async function refresh() {
    try {
      const data = await fetch(base).then((r) => r.json());
      ctx.setState("climate.currentTemp", data.temp);
      ctx.setState("climate.mode", MODE_NAMES[data.tmode] || "off");
      if (data.t_heat !== undefined) ctx.setState("climate.heatSetpoint", data.t_heat);
      if (data.t_cool !== undefined) ctx.setState("climate.coolSetpoint", data.t_cool);
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
