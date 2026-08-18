"use strict";
// UniFi Network Controller driver over its local "classic controller"
// API (port 8443, /api/s/<site>/...) - not officially published, but
// long-documented via community libraries and the Home Assistant unifi
// integration, moderate-high confidence. NOTE: a UniFi OS console
// (UDM/UDM-Pro/Cloud Gateway) exposes this under a different path prefix
// (/proxy/network/api/s/<site>/...) - this driver targets the classic
// controller path only. Self-signed cert - own https.Agent scoped to
// just this driver's requests, same pattern as ../tesla-powerwall.
const https = require("https");

const agent = new https.Agent({ rejectUnauthorized: false });
function httpsFetch(url, opts) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { agent, method: (opts && opts.method) || "GET", headers: { "Content-Type": "application/json", ...(opts && opts.headers) } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    if (opts && opts.body) req.write(opts.body);
    req.end();
  });
}

function create(ctx) {
  const host = ctx.config.connection.host;
  const port = ctx.config.connection.port || 8443;
  const base = `https://${host}:${port}`;
  let cookie = null;
  let pollHandle = null;

  async function login() {
    const res = await httpsFetch(`${base}/api/login`, { method: "POST", body: JSON.stringify({ username: ctx.config.settings.username, password: ctx.config.settings.password }) });
    const setCookie = res.headers["set-cookie"];
    if (setCookie) cookie = (Array.isArray(setCookie) ? setCookie : [setCookie]).map((c) => c.split(";")[0]).join("; ");
    return Boolean(cookie);
  }

  async function refresh() {
    // The initial login() call is INSIDE the try now, not before it - a
    // network-level rejection there (unreachable controller, DNS
    // failure, ...) used to escape uncaught, since onConnect() below
    // calls refresh() without awaiting it. Found via a real ECONNREFUSED
    // during this driver's own smoke test.
    try {
      if (!cookie && !(await login())) return;
      const site = ctx.config.settings.site || "default";
      let res = await httpsFetch(`${base}/api/s/${site}/stat/sta`, { headers: { Cookie: cookie } });
      if (res.status === 401 && (await login())) res = await httpsFetch(`${base}/api/s/${site}/stat/sta`, { headers: { Cookie: cookie } });
      const data = JSON.parse(res.body);
      const clients = data.data || [];
      ctx.setState("clients.count", clients.length);
      const targetMac = (ctx.config.settings.clientMac || "").toLowerCase();
      if (targetMac) ctx.setState("client.online", clients.some((c) => (c.mac || "").toLowerCase() === targetMac));
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
