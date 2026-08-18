"use strict";
// Matrix driver over the official, published Matrix Client-Server API
// (spec.matrix.org) - a real open protocol standard, high confidence.
// Sends a plain m.room.message event, authenticated with an access token
// (grab one from any existing Matrix client's settings - no OAuth dance
// needed for a bot-style sender like this).
function create(ctx) {
  let txnId = 0;

  ctx.onAction("sendMessage", async ({ message, roomId }) => {
    const homeserverUrl = (ctx.config.connection.homeserverUrl || "").replace(/\/$/, "");
    const room = roomId || ctx.config.settings.roomId;
    const token = ctx.config.settings.accessToken;
    if (!homeserverUrl || !room || !token) {
      ctx.log("homeserverUrl/roomId/accessToken must all be set");
      return;
    }
    txnId += 1;
    try {
      const res = await fetch(`${homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/oak-${Date.now()}-${txnId}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ msgtype: "m.text", body: message || "" }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      ctx.setState("last.sentAt", new Date().toISOString());
    } catch (err) {
      ctx.log(`sendMessage failed: ${err.message}`);
    }
  });

  return {
    onConnect() {},
    onDisconnect() {},
  };
}

module.exports = { create };
