"use strict";
// Nuki smart lock driver over the Nuki Bridge's own published local HTTP
// API (developer.nuki.io/page/nuki-bridge-http-api) - a real documented
// API, token-based auth (enable "API/token" in the Nuki app's Bridge
// settings to get the token this driver's `token` setting expects).
// Lock state codes (1=locked, 3/5/6=various unlocked states) and action
// codes (1=unlock, 2=lock, 3=unlatch) are Nuki's own published values.
const POLL_MS = 30000;

function create(ctx) {
  const host = ctx.config.connection.host;
  const port = ctx.config.connection.port || 8080;
  const base = `http://${host}:${port}`;

  let pollHandle = null;

  async function api(path, params) {
    const query = new URLSearchParams({ token: ctx.config.settings.token || "", ...params });
    const res = await fetch(`${base}${path}?${query.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  async function lockAction(action) {
    const nukiId = ctx.config.settings.nukiId;
    await api("/lockAction", { nukiId, action });
    refresh();
  }

  async function refresh() {
    const nukiId = ctx.config.settings.nukiId;
    if (!nukiId) return;
    try {
      const data = await api("/lockState", { nukiId });
      // 1=locked, 3=unlocked, 5=unlatched, 6=unlocked(lock'n'go) - anything
      // else (uncalibrated/motor blocked/mid-transition) is left as
      // whatever `locked` last was rather than guessed at.
      if (data.state === 1) ctx.setState("lock.locked", true);
      else if ([3, 5, 6].includes(data.state)) ctx.setState("lock.locked", false);
      if (data.batteryCritical !== undefined) ctx.setState("lock.batteryCritical", Boolean(data.batteryCritical));
    } catch (err) {
      ctx.log(`Refresh failed: ${err.message}`);
    }
  }

  ctx.onAction("lock", () => lockAction(2));
  ctx.onAction("unlock", () => lockAction(1));
  ctx.onAction("unlatch", () => lockAction(3));
  ctx.onAction("discoverLocks", async () => {
    try {
      const list = await api("/list", {});
      const locks = list.map((l) => ({ id: l.nukiId, name: l.name }));
      ctx.setState("discovery.locks", JSON.stringify(locks));
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
