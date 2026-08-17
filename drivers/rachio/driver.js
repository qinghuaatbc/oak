"use strict";
// Rachio irrigation driver over Rachio's own published public REST API
// (rachio.com/api docs, api.rach.io) - a real documented API with a
// simple long-lived API key (Bearer token), no OAuth dance needed.
const API_BASE = "https://api.rach.io/1/public";

function create(ctx) {
  const apiKey = ctx.config.settings.apiKey || "";

  async function api(path, opts) {
    const res = await fetch(`${API_BASE}${path}`, {
      ...opts,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...(opts && opts.headers) },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.status === 204 ? null : res.json();
  }

  ctx.onAction("startZone", async ({ zoneId, durationSeconds = 300 }) => {
    try {
      await api("/zone/start", { method: "PUT", body: JSON.stringify({ id: zoneId || ctx.config.settings.zoneId, duration: durationSeconds }) });
    } catch (err) {
      ctx.log(`startZone failed: ${err.message}`);
    }
  });
  ctx.onAction("stopWatering", async () => {
    const deviceId = ctx.config.settings.deviceId;
    try {
      await api("/device/stop_water", { method: "PUT", body: JSON.stringify({ id: deviceId }) });
    } catch (err) {
      ctx.log(`stopWatering failed: ${err.message}`);
    }
  });
  ctx.onAction("enableSchedule", async () => {
    try {
      await api("/device/on", { method: "PUT", body: JSON.stringify({ id: ctx.config.settings.deviceId }) });
    } catch (err) {
      ctx.log(`enableSchedule failed: ${err.message}`);
    }
  });
  ctx.onAction("disableSchedule", async () => {
    try {
      await api("/device/off", { method: "PUT", body: JSON.stringify({ id: ctx.config.settings.deviceId }) });
    } catch (err) {
      ctx.log(`disableSchedule failed: ${err.message}`);
    }
  });
  ctx.onAction("discoverDevices", async () => {
    try {
      const person = await api("/person/info");
      const info = await api(`/person/${person.id}`);
      const devices = (info.devices || []).map((d) => ({
        id: d.id,
        name: d.name,
        zones: (d.zones || []).map((z) => ({ id: z.id, name: z.name })),
      }));
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
