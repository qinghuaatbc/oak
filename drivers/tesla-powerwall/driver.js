"use strict";
// Tesla Powerwall driver over the Powerwall Gateway's own LOCAL HTTPS API
// (no cloud/internet needed at all) - not officially published by Tesla,
// but well documented by long-stable community projects (pypowerwall,
// tesla_powerwall) since the Gateway's API has changed little across
// installations, moderate-high confidence.
//
// The Gateway's TLS cert is ALWAYS self-signed (there's no way around
// this - Tesla ships every Gateway with its own unique self-signed cert,
// not a real CA-issued one) - unlike fetch(), which has no per-request
// way to disable cert verification, this driver builds its own minimal
// helper on Node's core `https` module with a dedicated Agent
// (rejectUnauthorized: false) scoped to ONLY this driver's own requests,
// deliberately not touching process-wide TLS verification (which would
// silently weaken every other driver's HTTPS calls too).
const https = require("https");

const agent = new https.Agent({ rejectUnauthorized: false });

function httpsRequest(url, opts) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { agent, method: (opts && opts.method) || "GET", headers: (opts && opts.headers) || {} }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    if (opts && opts.body) req.write(opts.body);
    req.end();
  });
}

function create(ctx) {
  const host = ctx.config.connection.host;
  const base = `https://${host}/api`;
  let authCookie = null;
  let pollHandle = null;

  async function login() {
    const res = await httpsRequest(`${base}/login/Basic`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "customer", email: ctx.config.settings.email || "", password: ctx.config.settings.password || "", clientInfo: { timezone: "UTC" } }),
    });
    const setCookie = res.headers["set-cookie"];
    if (setCookie) {
      const match = /AuthCookie=([^;]+)/.exec(Array.isArray(setCookie) ? setCookie.join(";") : setCookie);
      if (match) authCookie = match[1];
    }
    return Boolean(authCookie);
  }

  async function api(path, opts) {
    if (!authCookie && !(await login())) return null;
    async function attempt() {
      return httpsRequest(`${base}${path}`, { ...opts, headers: { Cookie: `AuthCookie=${authCookie}`, "Content-Type": "application/json", ...(opts && opts.headers) } });
    }
    let res = await attempt();
    if (res.status === 401 && (await login())) res = await attempt();
    if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
    return res.body ? JSON.parse(res.body) : null;
  }

  async function setOperation(mode, backupReservePercent) {
    try {
      await api("/operation", { method: "POST", body: JSON.stringify({ mode, backup_reserve_percent: backupReservePercent }) });
    } catch (err) {
      ctx.log(`setOperation failed: ${err.message}`);
    }
  }
  ctx.onAction("setSelfConsumption", () => setOperation("self_consumption", ctx.config.settings.backupReservePercent || 20));
  ctx.onAction("setBackupOnly", () => setOperation("backup", ctx.config.settings.backupReservePercent || 20));
  ctx.onAction("setBackupReserve", async ({ value }) => {
    try {
      const current = await api("/operation");
      await setOperation(current.mode, Math.max(0, Math.min(100, Math.round(value))));
    } catch (err) {
      ctx.log(`setBackupReserve failed: ${err.message}`);
    }
  });

  async function refresh() {
    try {
      const soe = await api("/system_status/soe");
      if (soe) ctx.setState("battery.percent", soe.percentage);
      const meters = await api("/meters/aggregates");
      if (meters) {
        if (meters.solar) ctx.setState("power.solar", meters.solar.instant_power);
        if (meters.load) ctx.setState("power.load", meters.load.instant_power);
        if (meters.battery) ctx.setState("power.battery", meters.battery.instant_power);
        if (meters.site) ctx.setState("power.grid", meters.site.instant_power);
      }
    } catch (err) {
      ctx.log(`Refresh failed: ${err.message}`);
    }
  }
  ctx.onAction("refresh", () => refresh());

  return {
    onConnect() {
      refresh();
      pollHandle = ctx.clock.every(30000, refresh);
    },
    onDisconnect() {
      if (pollHandle) pollHandle.cancel();
    },
  };
}

module.exports = { create };
