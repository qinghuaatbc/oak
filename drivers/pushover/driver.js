"use strict";
// Pushover push-notification driver over Pushover's own published REST API
// (pushover.net/api) - a fixed cloud endpoint, not a per-installation host,
// so this manifest's connection has no fields at all; credentials (an app
// token + a user/group key, both created on pushover.net) live in settings
// instead. Send-only: Pushover has no state to poll or events to push back
// to us here, so this driver has no onConnect network activity beyond
// logging readiness.
const API_URL = "https://api.pushover.net/1/messages.json";

function create(ctx) {
  const apiToken = (ctx.config.settings && ctx.config.settings.apiToken) || "";
  const userKey = (ctx.config.settings && ctx.config.settings.userKey) || "";

  ctx.onAction("sendMessage", async ({ message, title, priority = 0, sound, url, urlTitle }) => {
    if (!message) {
      ctx.log("sendMessage: message is required");
      return;
    }
    const body = new URLSearchParams({ token: apiToken, user: userKey, message: String(message) });
    if (title) body.set("title", String(title));
    if (priority) body.set("priority", String(priority));
    if (sound) body.set("sound", String(sound));
    if (url) body.set("url", String(url));
    if (urlTitle) body.set("url_title", String(urlTitle));
    // Priority 2 ("emergency" - repeats until acknowledged) is the one
    // Pushover priority level that REQUIRES retry/expire, per their own
    // API docs - reasonable fixed defaults here rather than exposing two
    // more action params for a case most callers won't need to tune.
    if (Number(priority) === 2) {
      body.set("retry", "60");
      body.set("expire", "3600");
    }
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      const data = await res.json();
      if (!res.ok || data.status !== 1) {
        const errMsg = (data.errors && data.errors.join(", ")) || `HTTP ${res.status}`;
        ctx.log("sendMessage failed:", errMsg);
        ctx.emitEvent("sendFailed", { error: errMsg });
        return;
      }
      ctx.setState("lastMessage", String(message));
      ctx.setState("lastSentAt", Date.now());
      ctx.emitEvent("messageSent", { title: title || "", message: String(message) });
    } catch (err) {
      ctx.log("sendMessage failed:", err.message);
      ctx.emitEvent("sendFailed", { error: err.message });
    }
  });

  return {
    onConnect() {
      ctx.log(apiToken && userKey ? "Pushover ready" : "Pushover: apiToken/userKey not configured yet");
    },
    onDisconnect() {},
  };
}
module.exports = { create };
