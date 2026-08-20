"use strict";
// Tasmota driver over its built-in HTTP command API (`/cm?cmnd=...`) -
// HIGH confidence: this is one of the most widely-documented open-source
// device firmwares in existence (runs on countless Sonoff/Shelly-clone/
// generic ESP8266-ESP32 plugs and switches), with a stable, unchanged
// command surface across years of releases. Uses HTTP polling rather
// than Tasmota's also-common MQTT telemetry, since Oak's HTTP transport
// needs no separate broker connection to configure - a future MQTT-based
// variant could reuse ../mqtt-plug's hand-rolled MQTT client if push-
// based state updates are ever needed instead of polling.
function create(ctx) {
  function relaySuffix() {
    const idx = String(ctx.config.settings.relayIndex || "").trim();
    return idx ? idx : "";
  }
  async function sendCommand(cmnd) {
    const { username, password } = ctx.config.settings;
    const authParams = username ? `user=${encodeURIComponent(username)}&password=${encodeURIComponent(password || "")}&` : "";
    const url = `http://${ctx.config.connection.host}/cm?${authParams}cmnd=${encodeURIComponent(cmnd)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  ctx.onAction("turnOn", async () => {
    try {
      const data = await sendCommand(`Power${relaySuffix()} On`);
      applyPowerResult(data);
    } catch (err) {
      ctx.log(`turnOn failed: ${err.message}`);
    }
  });
  ctx.onAction("turnOff", async () => {
    try {
      const data = await sendCommand(`Power${relaySuffix()} Off`);
      applyPowerResult(data);
    } catch (err) {
      ctx.log(`turnOff failed: ${err.message}`);
    }
  });
  ctx.onAction("toggle", async () => {
    try {
      const data = await sendCommand(`Power${relaySuffix()} Toggle`);
      applyPowerResult(data);
    } catch (err) {
      ctx.log(`toggle failed: ${err.message}`);
    }
  });
  ctx.onAction("setDimmer", async ({ level }) => {
    try {
      const data = await sendCommand(`Dimmer ${Math.max(0, Math.min(100, Math.round(level)))}`);
      if (data && typeof data.Dimmer === "number") ctx.setState("dimmer", data.Dimmer);
    } catch (err) {
      ctx.log(`setDimmer failed: ${err.message}`);
    }
  });

  function applyPowerResult(data) {
    if (!data) return;
    const key = Object.keys(data).find((k) => k.startsWith("POWER"));
    if (key) ctx.setState("power", data[key] === "ON");
  }

  async function refresh() {
    try {
      const data = await sendCommand("Status 11"); // StatusSTS - current power/dimmer state
      const sts = data && data.StatusSTS;
      if (sts) {
        applyPowerResult(sts);
        if (typeof sts.Dimmer === "number") ctx.setState("dimmer", sts.Dimmer);
      }
    } catch (err) {
      ctx.log(`Refresh failed: ${err.message}`);
    }
  }
  ctx.onAction("refresh", refresh);

  let pollTimer = null;

  return {
    onConnect() {
      refresh();
      pollTimer = ctx.clock.every(60000, refresh);
    },
    onDisconnect() {
      if (pollTimer) pollTimer.cancel();
    },
  };
}

module.exports = { create };
