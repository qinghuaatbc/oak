"use strict";
// Bond Bridge driver over their own OFFICIALLY published Local API
// (docs.bondhome.io) - controls ceiling fans, fireplaces, and shades via
// learned RF/IR codes. Real, official, high confidence. Auth is a
// BOND-Token header obtained once from the Bond Home app (not a login
// flow this driver drives itself).
function create(ctx) {
  const host = ctx.config.connection.host;
  const base = `http://${host}/v2`;

  function headers() {
    return { "BOND-Token": ctx.config.settings.token || "", "Content-Type": "application/json" };
  }
  async function action(name, argument) {
    const deviceId = ctx.config.settings.deviceId;
    try {
      await fetch(`${base}/devices/${deviceId}/actions/${name}`, { method: "PUT", headers: headers(), body: JSON.stringify(argument !== undefined ? { argument } : {}) });
    } catch (err) {
      ctx.log(`${name} failed: ${err.message}`);
    }
  }
  ctx.onAction("turnOn", () => action("TurnOn"));
  ctx.onAction("turnOff", () => action("TurnOff"));
  ctx.onAction("setSpeed", ({ value }) => action("SetSpeed", Math.max(1, Math.min(6, Math.round(value)))));
  ctx.onAction("toggleOpen", () => action("ToggleOpen"));

  ctx.onAction("discoverDevices", async () => {
    try {
      const data = await fetch(`${base}/devices`, { headers: headers() }).then((r) => r.json());
      const ids = Object.keys(data).filter((k) => k !== "_" && !k.startsWith("_"));
      const devices = [];
      for (const id of ids) {
        try {
          const info = await fetch(`${base}/devices/${id}`, { headers: headers() }).then((r) => r.json());
          devices.push({ id, name: info.name });
        } catch {
          devices.push({ id });
        }
      }
      ctx.setState("discovery.devices", JSON.stringify(devices));
    } catch (err) {
      ctx.log(`discoverDevices failed: ${err.message}`);
    }
  });

  return {
    onConnect() {},
    onDisconnect() {},
  };
}

module.exports = { create };
