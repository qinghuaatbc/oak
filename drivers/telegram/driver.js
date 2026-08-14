"use strict";
// Telegram Bot driver over Telegram's own published Bot API
// (core.telegram.org/bots/api) - create a bot via @BotFather to get a
// token; a fixed cloud endpoint, same "no connection fields, just
// settings" shape as the Pushover driver.
const API_BASE = "https://api.telegram.org";

function create(ctx) {
  const botToken = (ctx.config.settings && ctx.config.settings.botToken) || "";
  const defaultChatId = (ctx.config.settings && ctx.config.settings.chatId) || "";

  ctx.onAction("sendMessage", async ({ text, chatId }) => {
    const targetChatId = chatId || defaultChatId;
    if (!text) {
      ctx.log("sendMessage: text is required");
      return;
    }
    if (!targetChatId) {
      ctx.log("sendMessage: no chat ID given and no default chat ID configured");
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: targetChatId, text: String(text) }),
      });
      const data = await res.json();
      if (!data.ok) {
        ctx.log("sendMessage failed:", data.description || `HTTP ${res.status}`);
        ctx.emitEvent("sendFailed", { error: data.description || `HTTP ${res.status}` });
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
      ctx.log(botToken ? "Telegram bot ready" : "Telegram: botToken not configured yet");
    },
    onDisconnect() {},
  };
}
module.exports = { create };
