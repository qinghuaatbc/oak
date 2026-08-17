"use strict";
// Yamaha / MusicCast AVR driver over Yamaha's own published YXC
// ("Yamaha Extended Control") HTTP API - a real, documented API (Yamaha
// publishes "MusicCast CONTROLLER API Specifications" for third-party
// integrators), not reverse-engineered. Unusually for a REST-ish API,
// every YXC call is a GET with query-string parameters, even ones with
// side effects (setPower, setVolume, ...) - that is genuinely how this
// API works, confirmed consistently across every independent open-source
// implementation of it, not a mistake in this driver.
//
// Volume is device-relative (Yamaha reports a model-specific max_volume,
// not a fixed 0-100 scale) - this driver reads max_volume once via
// getStatus and scales its own 0-100 setVolume input against it, so a
// Dashboard slider means the same thing regardless of which receiver
// model is behind it.
const POLL_MS = 15000;

function create(ctx) {
  const host = ctx.config.connection.host;
  const zone = ctx.config.settings.zone || "main";
  const base = `http://${host}/YamahaExtendedControl/v1`;

  let maxVolume = 100;
  let pollHandle = null;

  async function api(path) {
    const res = await fetch(`${base}${path}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function refresh() {
    try {
      const status = await api(`/${zone}/getStatus`);
      if (status.max_volume) maxVolume = status.max_volume;
      ctx.setState("power.on", status.power === "on");
      ctx.setState("power.volume", Math.round((status.volume / maxVolume) * 100));
      ctx.setState("power.muted", Boolean(status.mute));
      ctx.setState("power.input", status.input);
    } catch (err) {
      ctx.log(`Refresh failed: ${err.message}`);
    }
  }

  ctx.onAction("turnOn", async () => {
    await api(`/${zone}/setPower?power=on`);
    refresh();
  });
  ctx.onAction("turnOff", async () => {
    await api(`/${zone}/setPower?power=standby`);
    refresh();
  });
  ctx.onAction("setVolume", async ({ value }) => {
    const raw = Math.round((Math.max(0, Math.min(100, value)) / 100) * maxVolume);
    await api(`/${zone}/setVolume?volume=${raw}`);
    refresh();
  });
  ctx.onAction("mute", async () => {
    await api(`/${zone}/setMute?enable=true`);
    refresh();
  });
  ctx.onAction("unmute", async () => {
    await api(`/${zone}/setMute?enable=false`);
    refresh();
  });
  ctx.onAction("setInput", async ({ input }) => {
    await api(`/${zone}/setInput?input=${encodeURIComponent(input)}`);
    refresh();
  });
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
