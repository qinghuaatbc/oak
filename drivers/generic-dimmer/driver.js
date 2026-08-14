"use strict";
// Generic dimmable-light driver over plain HTTP - same request/response
// shape as http-relay (GET /light for status, GET /light?turn=on|off or
// ?level=N to control), extended with a 0-100 level. Targets a generic
// local HTTP dimmer API convention, not any single vendor's proprietary
// protocol.

function create(ctx) {
  const baseUrl = ctx.http.baseUrl;
  let pollHandle = null;
  let lastOn = null;
  let lastLevel = null;

  async function fetchStatus() {
    try {
      const res = await fetch(`${baseUrl}/light`);
      const data = await res.json();
      let changed = false;
      if (lastOn !== data.ison) {
        lastOn = data.ison;
        ctx.setState("light.on", data.ison);
        changed = true;
      }
      if (lastLevel !== data.level) {
        lastLevel = data.level;
        ctx.setState("light.level", data.level);
        changed = true;
      }
      if (changed) ctx.emitEvent("stateChanged", { on: lastOn, level: lastLevel });
    } catch (err) {
      ctx.log("status poll failed:", err.message);
    }
  }

  async function setTurn(turn) {
    await fetch(`${baseUrl}/light?turn=${turn}`);
    await fetchStatus();
  }
  async function setLevel(level) {
    await fetch(`${baseUrl}/light?level=${Math.max(0, Math.min(100, Math.round(level)))}`);
    await fetchStatus();
  }

  ctx.onAction("turnOn", () => setTurn("on"));
  ctx.onAction("turnOff", () => setTurn("off"));
  ctx.onAction("setLevel", ({ level = 100 }) => setLevel(level));

  return {
    onConnect() {
      ctx.log("Polling", baseUrl);
      fetchStatus();
      const intervalMs = (ctx.config.settings && ctx.config.settings.pollIntervalMs) || 5000;
      pollHandle = ctx.clock.every(intervalMs, () => fetchStatus());
    },
    onDisconnect() {
      if (pollHandle) pollHandle.cancel();
    },
  };
}

module.exports = { create };
