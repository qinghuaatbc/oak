"use strict";
// Discord webhook driver - Discord's own published, deliberately simple
// incoming-webhook API (a POST with a JSON body). High confidence.
function create(ctx) {
  ctx.onAction("send", async ({ content }) => {
    const webhookUrl = ctx.config.settings.webhookUrl;
    if (!webhookUrl) {
      ctx.log("webhookUrl not configured");
      return;
    }
    const body = { content: content || "" };
    if (ctx.config.settings.username) body.username = ctx.config.settings.username;
    try {
      const res = await fetch(webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
      ctx.setState("last.sentAt", new Date().toISOString());
    } catch (err) {
      ctx.log(`send failed: ${err.message}`);
    }
  });

  return {
    onConnect() {},
    onDisconnect() {},
  };
}

module.exports = { create };
