"use strict";
// Pushbullet driver over their own published REST API
// (docs.pushbullet.com) - real, official, simple, high confidence.
function create(ctx) {
  ctx.onAction("sendNote", async ({ title, body }) => {
    const token = ctx.config.settings.accessToken;
    if (!token) {
      ctx.log("accessToken not configured");
      return;
    }
    try {
      const res = await fetch("https://api.pushbullet.com/v2/pushes", {
        method: "POST",
        headers: { "Access-Token": token, "Content-Type": "application/json" },
        body: JSON.stringify({ type: "note", title: title || "", body: body || "" }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      ctx.setState("last.sentAt", new Date().toISOString());
    } catch (err) {
      ctx.log(`sendNote failed: ${err.message}`);
    }
  });

  return {
    onConnect() {},
    onDisconnect() {},
  };
}

module.exports = { create };
