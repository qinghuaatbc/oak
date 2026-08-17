"use strict";
// Samsung SmartThings driver over their own published REST API
// (developer.smartthings.com), a real public API (not reverse-engineered)
// using a Personal Access Token - simpler than a full OAuth app
// registration for a single-user integration like this one, and the auth
// method SmartThings' own docs recommend for exactly this case. Polled
// (SmartThings does have a webhook/SSE subscription model for apps, but
// that needs a publicly reachable callback URL to register, which Oak has
// no general answer for - polling is the same tradeoff this project's
// other cloud drivers, e.g. openweathermap/ecobee, already make).
const API_BASE = "https://api.smartthings.com/v1";
const POLL_MS = 30000;

function create(ctx) {
  const token = ctx.config.settings.token || "";
  let pollHandle = null;

  async function apiFetch(path, opts) {
    const res = await fetch(`${API_BASE}${path}`, {
      ...opts,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(opts && opts.headers) },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.status === 204 ? null : res.json();
  }
  async function sendCommand(capability, command, args) {
    const deviceId = ctx.config.settings.deviceId;
    await apiFetch(`/devices/${deviceId}/commands`, {
      method: "POST",
      body: JSON.stringify({ commands: [{ component: "main", capability, command, arguments: args || [] }] }),
    });
  }

  async function refresh() {
    const deviceId = ctx.config.settings.deviceId;
    if (!deviceId || !token) return;
    try {
      const status = await apiFetch(`/devices/${deviceId}/status`);
      const main = status.components && status.components.main;
      if (!main) return;
      if (main.switch) ctx.setState("device.on", main.switch.switch.value === "on");
      if (main.switchLevel) ctx.setState("device.level", Number(main.switchLevel.level.value));
      ctx.emitEvent("statusChanged", { status: main });
    } catch (err) {
      ctx.log(`Refresh failed: ${err.message}`);
    }
  }

  ctx.onAction("turnOn", () => sendCommand("switch", "on").then(refresh));
  ctx.onAction("turnOff", () => sendCommand("switch", "off").then(refresh));
  ctx.onAction("setLevel", ({ value }) => sendCommand("switchLevel", "setLevel", [Math.max(0, Math.min(100, value))]).then(refresh));
  ctx.onAction("sendCommand", ({ capability, command, args }) => {
    let parsed = [];
    try {
      parsed = args ? JSON.parse(args) : [];
    } catch {
      /* ignore malformed args, send none */
    }
    return sendCommand(capability, command, parsed);
  });
  ctx.onAction("discoverDevices", async () => {
    try {
      const data = await apiFetch("/devices");
      const devices = (data.items || []).map((d) => ({ id: d.deviceId, name: d.label || d.name }));
      ctx.setState("discovery.devices", JSON.stringify(devices));
    } catch (err) {
      ctx.log(`Discovery failed: ${err.message}`);
    }
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
