"use strict";
// Generic HTTP relay/switch driver. Targets the common "GET /relay/N?turn=
// on|off|toggle" shape used by several local-network relay devices' own
// published HTTP APIs - referenced here only to say what wire shape this
// driver speaks, not derived from any single vendor's app or firmware.
//
// Structurally different from the DSC driver on purpose: request/response
// over plain HTTP instead of a persistent framed socket, and status is
// discovered by polling rather than pushed by the device - proves the
// manifest/runtime split isn't secretly TCP-shaped underneath.

function create(ctx) {
  const baseUrl = ctx.http.baseUrl;
  let pollHandle = null;
  let lastOn = new Map();

  async function fetchStatus(relay) {
    try {
      const res = await fetch(`${baseUrl}/relay/${relay}`);
      const data = await res.json();
      if (lastOn.get(relay) !== data.ison) {
        lastOn.set(relay, data.ison);
        ctx.setState("relay.on", data.ison, String(relay));
        ctx.emitEvent("stateChanged", { relay, on: data.ison });
      }
    } catch (err) {
      ctx.log("status poll failed:", err.message);
    }
  }

  async function setRelay(relay, turn) {
    await fetch(`${baseUrl}/relay/${relay}?turn=${turn}`);
    await fetchStatus(relay);
  }

  ctx.onAction("turnOn", ({ relay = 0 }) => setRelay(relay, "on"));
  ctx.onAction("turnOff", ({ relay = 0 }) => setRelay(relay, "off"));
  ctx.onAction("toggle", ({ relay = 0 }) => setRelay(relay, "toggle"));

  return {
    onConnect() {
      ctx.log("Polling", baseUrl);
      fetchStatus(0);
      const intervalMs = (ctx.config.settings && ctx.config.settings.pollIntervalMs) || 5000;
      pollHandle = ctx.clock.every(intervalMs, () => fetchStatus(0));
    },
    onDisconnect() {
      if (pollHandle) pollHandle.cancel();
    },
  };
}

module.exports = { create };
