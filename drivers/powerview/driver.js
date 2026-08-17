"use strict";
// Hunter Douglas PowerView driver over the Hub's local JSON REST API -
// not officially published by Hunter Douglas, but stable and documented
// via community libraries (aiopvapi, Home Assistant's own powerview
// integration). Targets the Generation 3 Hub's "/home/..." API shape
// specifically - Generation 2 Hubs use a materially different "/api/..."
// path structure this driver does NOT support, so a Gen 2 Hub needs its
// own variant before this will work against it. Moderate confidence.
const POLL_MS = 30000;

function create(ctx) {
  const host = ctx.config.connection.host;
  const base = `http://${host}/home`;

  let pollHandle = null;

  async function setPosition(value) {
    const shadeId = ctx.config.settings.shadeId;
    try {
      await fetch(`${base}/shades/positions?ids=[${shadeId}]`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ positions: { primary: Math.max(0, Math.min(100, Math.round(value))) } }),
      });
      refresh();
    } catch (err) {
      ctx.log(`setPosition failed: ${err.message}`);
    }
  }
  ctx.onAction("open", () => setPosition(100));
  ctx.onAction("close", () => setPosition(0));
  ctx.onAction("setPosition", ({ value }) => setPosition(value));

  ctx.onAction("discoverShades", async () => {
    try {
      const data = await fetch(`${base}/shades`).then((r) => r.json());
      const shades = (data.shadeIds || data.shadeData || []).map((s) => (typeof s === "object" ? { id: s.id, name: s.name } : { id: s }));
      ctx.setState("discovery.shades", JSON.stringify(shades));
    } catch (err) {
      ctx.log(`discoverShades failed: ${err.message}`);
    }
  });

  async function refresh() {
    const shadeId = ctx.config.settings.shadeId;
    if (!shadeId) return;
    try {
      const data = await fetch(`${base}/shades/${shadeId}`).then((r) => r.json());
      const primary = data.positions && data.positions.primary;
      if (primary !== undefined) ctx.setState("shade.position", primary);
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
