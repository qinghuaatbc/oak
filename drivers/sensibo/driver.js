"use strict";
// Sensibo AC controller driver over their own published API
// (sensibo.com/api docs at yonomi.github.io/sensibo-py or Sensibo's own
// developer page) - a real, documented API, high confidence, simple
// long-lived API key query param auth.
const API_BASE = "https://home.sensibo.com/api/v2";
const POLL_MS = 60000;

function create(ctx) {
  let pollHandle = null;

  function apiKey() {
    return ctx.config.settings.apiKey || "";
  }
  async function setAcState(partial) {
    const podId = ctx.config.settings.podId;
    try {
      const current = await fetch(`${API_BASE}/pods/${podId}?fields=acState&apiKey=${apiKey()}`).then((r) => r.json());
      const acState = { ...(current.result && current.result.acState), ...partial };
      await fetch(`${API_BASE}/pods/${podId}/acStates?apiKey=${apiKey()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acState }),
      });
      refresh();
    } catch (err) {
      ctx.log(`Command failed: ${err.message}`);
    }
  }

  ctx.onAction("turnOn", () => setAcState({ on: true }));
  ctx.onAction("turnOff", () => setAcState({ on: false }));
  ctx.onAction("setTemperature", ({ value }) => setAcState({ on: true, targetTemperature: Math.round(value), temperatureUnit: "C" }));
  ctx.onAction("setMode", ({ mode }) => setAcState({ on: true, mode }));

  ctx.onAction("discoverPods", async () => {
    try {
      const data = await fetch(`${API_BASE}/users/me/pods?apiKey=${apiKey()}`).then((r) => r.json());
      const pods = (data.result || []).map((p) => ({ id: p.id }));
      ctx.setState("discovery.pods", JSON.stringify(pods));
    } catch (err) {
      ctx.log(`discoverPods failed: ${err.message}`);
    }
  });

  async function refresh() {
    const podId = ctx.config.settings.podId;
    if (!podId) return;
    try {
      const data = await fetch(`${API_BASE}/pods/${podId}?fields=acState&apiKey=${apiKey()}`).then((r) => r.json());
      const acState = data.result && data.result.acState;
      if (!acState) return;
      ctx.setState("ac.on", Boolean(acState.on));
      ctx.setState("ac.targetTemperature", acState.targetTemperature);
      ctx.setState("ac.mode", acState.mode);
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
