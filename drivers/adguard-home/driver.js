"use strict";
// AdGuard Home driver over its own published local REST API
// (github.com/AdguardTeam/AdGuardHome has a documented openapi.yaml) -
// real, documented, open source, high confidence. Basic Auth using the
// same admin credentials set up during AdGuard Home's initial setup
// wizard.
const POLL_MS = 60000;

function create(ctx) {
  const host = ctx.config.connection.host;
  const port = ctx.config.connection.port || 3000;
  const base = `http://${host}:${port}/control`;

  let pollHandle = null;

  function headers() {
    const { username, password } = ctx.config.settings;
    const h = { "Content-Type": "application/json" };
    if (username) h.Authorization = `Basic ${Buffer.from(`${username}:${password || ""}`).toString("base64")}`;
    return h;
  }

  ctx.onAction("enableProtection", async () => {
    try {
      await fetch(`${base}/protection`, { method: "POST", headers: headers(), body: JSON.stringify({ enabled: true, duration: 0 }) });
      refresh();
    } catch (err) {
      ctx.log(`enableProtection failed: ${err.message}`);
    }
  });
  ctx.onAction("disableProtection", async ({ durationMinutes = 0 }) => {
    try {
      await fetch(`${base}/protection`, { method: "POST", headers: headers(), body: JSON.stringify({ enabled: false, duration: durationMinutes * 60000 }) });
      refresh();
    } catch (err) {
      ctx.log(`disableProtection failed: ${err.message}`);
    }
  });

  async function refresh() {
    try {
      const status = await fetch(`${base}/status`, { headers: headers() }).then((r) => r.json());
      ctx.setState("protection.enabled", Boolean(status.protection_enabled));
      const stats = await fetch(`${base}/stats`, { headers: headers() }).then((r) => r.json());
      ctx.setState("stats.queriesToday", stats.num_dns_queries);
      ctx.setState("stats.blockedToday", stats.num_blocked_filtering);
    } catch (err) {
      ctx.log(`Refresh failed: ${err.message}`);
    }
  }
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
