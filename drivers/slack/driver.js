"use strict";
// Slack driver over Slack's own Incoming Webhooks feature
// (api.slack.com/messaging/webhooks) - a per-workspace URL created in
// Slack's own app settings, not a bot token/OAuth flow, so settings holds
// just the one webhook URL. Slack's webhook endpoint is unusual among the
// APIs the other new drivers use: on success it returns the literal text
// "ok" (200) rather than a JSON body, and on failure a short plain-text
// error code (e.g. "invalid_payload", "channel_not_found") - handled as
// text, not JSON, on purpose.
function create(ctx) {
  const webhookUrl = (ctx.config.settings && ctx.config.settings.webhookUrl) || "";

  ctx.onAction("sendMessage", async ({ text, channel }) => {
    if (!text) {
      ctx.log("sendMessage: text is required");
      return;
    }
    if (!webhookUrl) {
      ctx.log("sendMessage: webhookUrl not configured");
      return;
    }
    const payload = { text: String(text) };
    if (channel) payload.channel = String(channel);
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.text();
      if (!res.ok || body.trim() !== "ok") {
        ctx.log("sendMessage failed:", body || `HTTP ${res.status}`);
        ctx.emitEvent("sendFailed", { error: body || `HTTP ${res.status}` });
        return;
      }
      ctx.setState("lastMessage", String(text));
      ctx.setState("lastSentAt", Date.now());
      ctx.emitEvent("messageSent", { text: String(text) });
    } catch (err) {
      ctx.log("sendMessage failed:", err.message);
      ctx.emitEvent("sendFailed", { error: err.message });
    }
  });

  return {
    onConnect() {
      ctx.log(webhookUrl ? "Slack webhook ready" : "Slack: webhookUrl not configured yet");
    },
    onDisconnect() {},
  };
}
module.exports = { create };
