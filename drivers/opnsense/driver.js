"use strict";
// OPNsense driver over their own published REST API
// (docs.opnsense.org/development/api.html) - a real, officially
// documented API with a consistent /api/<module>/<controller>/<command>
// URL convention across the whole firewall, high confidence. Auth is a
// generated API key/secret pair used as HTTP Basic credentials (System >
// Access > Users, per-user "API keys" section) - not a username/password
// login.
//
// Scoped to the well-documented "core" module (system reboot, service
// start/stop/restart, firmware status) rather than the huge
// firewall-rule/alias/NAT surface OPNsense also exposes - those have
// many module-specific endpoint shapes better added individually, on
// request, against a real firewall to verify the exact controller names
// in use.
function create(ctx) {
  const host = ctx.config.connection.host;
  const base = `https://${host}/api`;

  async function api(path, opts) {
    const { apiKey, apiSecret } = ctx.config.settings;
    const basic = Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");
    const res = await fetch(`${base}${path}`, { ...opts, headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/json", ...(opts && opts.headers) } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  ctx.onAction("reboot", () => api("/core/system/reboot", { method: "POST" }).catch((err) => ctx.log(`reboot failed: ${err.message}`)));
  ctx.onAction("restartService", ({ service }) => api(`/core/service/restart/${encodeURIComponent(service)}`, { method: "POST" }).catch((err) => ctx.log(`restartService failed: ${err.message}`)));
  ctx.onAction("stopService", ({ service }) => api(`/core/service/stop/${encodeURIComponent(service)}`, { method: "POST" }).catch((err) => ctx.log(`stopService failed: ${err.message}`)));
  ctx.onAction("startService", ({ service }) => api(`/core/service/start/${encodeURIComponent(service)}`, { method: "POST" }).catch((err) => ctx.log(`startService failed: ${err.message}`)));

  async function refresh() {
    try {
      const data = await api("/core/firmware/status");
      ctx.setState("firmware.status", data.status);
    } catch (err) {
      ctx.log(`Refresh failed: ${err.message}`);
    }
  }
  ctx.onAction("refresh", () => refresh());

  return {
    onConnect() {
      refresh();
    },
    onDisconnect() {},
  };
}

module.exports = { create };
