"use strict";
// RainMachine driver over their own OFFICIALLY published local HTTPS API
// (RainMachine documents this themselves for developers) - real,
// official, high confidence. The controller's TLS cert is self-signed,
// so this uses its own https.Agent (rejectUnauthorized scoped to just
// this driver's requests) same as ../tesla-powerwall.
const https = require("https");

const agent = new https.Agent({ rejectUnauthorized: false });
function httpsFetch(url, opts) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { agent, method: (opts && opts.method) || "GET", headers: { "Content-Type": "application/json", ...(opts && opts.headers) } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    if (opts && opts.body) req.write(opts.body);
    req.end();
  });
}

function create(ctx) {
  const host = ctx.config.connection.host;
  const port = ctx.config.connection.port || 8080;
  const base = `https://${host}:${port}/api/4`;
  let accessToken = null;

  async function login() {
    const res = await httpsFetch(`${base}/auth/login`, { method: "POST", body: JSON.stringify({ pwd: ctx.config.settings.password, remember: 1 }) });
    const data = JSON.parse(res.body);
    accessToken = data.access_token;
    return Boolean(accessToken);
  }

  async function api(path, opts) {
    if (!accessToken && !(await login())) return null;
    const sep = path.includes("?") ? "&" : "?";
    const res = await httpsFetch(`${base}${path}${sep}access_token=${accessToken}`, opts);
    return res.body ? JSON.parse(res.body) : null;
  }

  ctx.onAction("startZone", async ({ zoneId, durationSeconds = 300 }) => {
    const id = zoneId || ctx.config.settings.zoneId;
    try {
      await api(`/zone/${id}/start`, { method: "POST", body: JSON.stringify({ duration: durationSeconds }) });
    } catch (err) {
      ctx.log(`startZone failed: ${err.message}`);
    }
  });
  ctx.onAction("stopZone", async ({ zoneId }) => {
    const id = zoneId || ctx.config.settings.zoneId;
    try {
      await api(`/zone/${id}/stop`, { method: "POST" });
    } catch (err) {
      ctx.log(`stopZone failed: ${err.message}`);
    }
  });
  ctx.onAction("discoverZones", async () => {
    try {
      const data = await api("/zone");
      const zones = (data.zones || []).map((z) => ({ id: z.uid, name: z.name }));
      ctx.setState("discovery.zones", JSON.stringify(zones));
    } catch (err) {
      ctx.log(`discoverZones failed: ${err.message}`);
    }
  });

  return {
    onConnect() {},
    onDisconnect() {},
  };
}

module.exports = { create };
