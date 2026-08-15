"use strict";
// Govee driver over their own official OpenAPI (developer-api.govee.com) -
// a fixed cloud endpoint, keyed by a Govee-API-Key header (request one in
// the Govee Home app). A Govee device is addressed by MAC *and* model
// together, not a single id the way Hue/LIFX use - this driver combines
// both into one "MAC|Model" string for every action/state param so it
// still fits Oak's single-string per-device address convention, splitting
// it back apart only when calling Govee's own two-field API shape. No
// bulk state endpoint exists, so status is polled per-device (one request
// per device known via the deviceNames setting), not a single list call.
const API_BASE = "https://developer-api.govee.com/v1";

function create(ctx) {
  const apiKey = (ctx.config.settings && ctx.config.settings.apiKey) || "";
  let pollHandle = null;
  let lastState = new Map(); // "mac|model" -> "on:level" snapshot

  function authHeaders() {
    return { "Govee-API-Key": apiKey, "Content-Type": "application/json" };
  }
  function splitDevice(device) {
    const idx = (device || "").indexOf("|");
    if (idx === -1) return null;
    return { mac: device.slice(0, idx), model: device.slice(idx + 1) };
  }

  function knownDevices() {
    const names = (ctx.config.settings && ctx.config.settings.deviceNames) || {};
    return Object.keys(names);
  }

  async function fetchOneStatus(device) {
    const parts = splitDevice(device);
    if (!parts) return;
    try {
      const res = await fetch(`${API_BASE}/devices/state?device=${encodeURIComponent(parts.mac)}&model=${encodeURIComponent(parts.model)}`, {
        headers: authHeaders(),
      });
      const data = await res.json();
      if (!res.ok || data.code !== 200) {
        ctx.log(`status poll (${device}) failed:`, data.message || `HTTP ${res.status}`);
        return;
      }
      const props = (data.data && data.data.properties) || [];
      const powerProp = props.find((p) => "powerState" in p);
      const brightnessProp = props.find((p) => "brightness" in p);
      const on = powerProp ? powerProp.powerState === "on" : false;
      const level = brightnessProp ? brightnessProp.brightness : 0;
      const snapshot = `${on}:${level}`;
      if (lastState.get(device) === snapshot) return;
      lastState.set(device, snapshot);
      ctx.setState("light.on", on, device);
      ctx.setState("light.level", level, device);
    } catch (err) {
      ctx.log(`status poll (${device}) failed:`, err.message);
    }
  }
  function fetchAllStatus() {
    return Promise.all(knownDevices().map(fetchOneStatus));
  }

  async function control(device, cmd) {
    const parts = splitDevice(device);
    if (!parts) {
      ctx.log(`control: "${device}" isn't a valid "MAC|Model" address - run Discover Devices and pick one from there`);
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/devices/control`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({ device: parts.mac, model: parts.model, cmd }),
      });
      const data = await res.json();
      if (!res.ok || data.code !== 200) {
        ctx.log(`control(${device}) failed:`, data.message || `HTTP ${res.status}`);
        return;
      }
      await fetchOneStatus(device);
    } catch (err) {
      ctx.log(`control(${device}) failed:`, err.message);
    }
  }

  ctx.onAction("turnOn", ({ device }) => control(device, { name: "turn", value: "on" }));
  ctx.onAction("turnOff", ({ device }) => control(device, { name: "turn", value: "off" }));
  ctx.onAction("setBrightness", ({ device, level = 100 }) => control(device, { name: "brightness", value: Math.max(0, Math.min(100, Math.round(level))) }));
  ctx.onAction("discoverDevices", async () => {
    try {
      const res = await fetch(`${API_BASE}/devices`, { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok || data.code !== 200) {
        ctx.log("discoverDevices failed:", data.message || `HTTP ${res.status}`);
        return;
      }
      const devices = (data.data && data.data.devices) || [];
      const nodes = devices.map((d) => ({ address: `${d.device}|${d.model}`, name: d.deviceName || d.device }));
      ctx.setState("discovery.nodes", JSON.stringify(nodes));
      ctx.emitEvent("nodesDiscovered", { count: nodes.length });
    } catch (err) {
      ctx.log("discoverDevices failed:", err.message);
    }
  });

  return {
    onConnect() {
      ctx.log("Polling Govee Cloud API");
      fetchAllStatus();
      const intervalMs = (ctx.config.settings && ctx.config.settings.pollIntervalMs) || 10000;
      pollHandle = ctx.clock.every(intervalMs, fetchAllStatus);
    },
    onDisconnect() {
      if (pollHandle) pollHandle.cancel();
    },
  };
}
module.exports = { create };
