"use strict";
// ntfy driver - ntfy.sh's own published, deliberately simple pub/sub
// notification API (a POST with the message as the raw body, metadata as
// headers). Works against the public ntfy.sh or any self-hosted ntfy
// server (docs.ntfy.sh), high confidence - this API is intentionally
// about as simple as a notification API gets.
function create(ctx) {
  const baseUrl = (ctx.config.connection.baseUrl || "https://ntfy.sh").replace(/\/$/, "");

  ctx.onAction("send", async ({ message, title, priority, tags, clickUrl }) => {
    const topic = ctx.config.settings.topic;
    if (!topic) {
      ctx.log("No topic configured");
      return;
    }
    const headers = { "Content-Type": "text/plain; charset=utf-8" };
    if (title) headers["Title"] = title;
    if (priority) headers["Priority"] = String(priority);
    if (tags) headers["Tags"] = tags;
    if (clickUrl) headers["Click"] = clickUrl;
    if (ctx.config.settings.accessToken) headers["Authorization"] = `Bearer ${ctx.config.settings.accessToken}`;
    try {
      const res = await fetch(`${baseUrl}/${encodeURIComponent(topic)}`, { method: "POST", headers, body: message || "" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
