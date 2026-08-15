"use strict";
// Shelly (Gen1) driver over the device's own local HTTP API
// (shelly-api-docs.shelly.cloud, Gen1 REST endpoints) - GET /relay/<n>?
// turn=on|off|toggle to control, GET /relay/<n> for status. Gen2+ devices
// (Shelly Plus/Pro) speak a different JSON-RPC API (/rpc, Switch.Set/
// Switch.GetStatus) and aren't covered here - a real, deliberate scope
// cut, not an oversight; worth a separate "shelly-gen2" driver if needed.
//
// Every fetch here is wrapped in its own try/catch, including the control
// call - unlike a real bug already found and left alone in this project's
// own http-relay driver (setRelay()'s fetch had none, so a toggle against
// an unreachable device threw an unhandled promise rejection instead of
// just logging). Worth not repeating that mistake in a new driver just
// because it happens to be the closest existing example to copy from.
function create(ctx) {
  const baseUrl = ctx.http.baseUrl;
  let pollHandle = null;
  let lastOn = new Map(); // relay index -> boolean

  async function fetchStatus(relay) {
    try {
      const res = await fetch(`${baseUrl}/relay/${relay}`);
      const data = await res.json();
      if (lastOn.get(relay) !== data.ison) {
        lastOn.set(relay, data.ison);
        ctx.setState("relay.on", Boolean(data.ison), String(relay));
        ctx.emitEvent("stateChanged", { relay, on: Boolean(data.ison) });
      }
    } catch (err) {
      ctx.log(`status poll (relay ${relay}) failed:`, err.message);
    }
  }

  async function setRelay(relay, turn) {
    try {
      await fetch(`${baseUrl}/relay/${relay}?turn=${turn}`);
      await fetchStatus(relay);
    } catch (err) {
      ctx.log(`setRelay(${relay}, ${turn}) failed:`, err.message);
    }
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
