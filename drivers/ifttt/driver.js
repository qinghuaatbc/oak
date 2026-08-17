"use strict";
// IFTTT driver over their own published Webhooks (Maker) service - a
// deliberately simple, official API, high confidence.
function create(ctx) {
  ctx.onAction("trigger", async ({ event, value1, value2, value3 }) => {
    const key = ctx.config.settings.webhookKey;
    if (!key || !event) {
      ctx.log("webhookKey/event must both be set");
      return;
    }
    try {
      const res = await fetch(`https://maker.ifttt.com/trigger/${encodeURIComponent(event)}/with/key/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value1, value2, value3 }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      ctx.setState("last.triggeredAt", new Date().toISOString());
    } catch (err) {
      ctx.log(`trigger failed: ${err.message}`);
    }
  });

  return {
    onConnect() {},
    onDisconnect() {},
  };
}

module.exports = { create };
