"use strict";
// Kodi driver over Kodi's own published JSON-RPC API
// (kodi.wiki/view/JSON-RPC_API) - a real, official, extensively
// documented API, high confidence. Uses the HTTP transport (POST
// /jsonrpc) rather than the WebSocket one Kodi also offers, since HTTP
// is simpler for this driver's fire-and-refresh command model and is
// the more commonly-enabled option (Settings > Services > Control >
// Allow remote control via HTTP).
function create(ctx) {
  const host = ctx.config.connection.host;
  const port = ctx.config.connection.port || 8080;
  const base = `http://${host}:${port}/jsonrpc`;
  let requestId = 0;

  async function rpc(method, params) {
    requestId += 1;
    const headers = { "Content-Type": "application/json" };
    const { username, password } = ctx.config.settings;
    if (username) headers.Authorization = `Basic ${Buffer.from(`${username}:${password || ""}`).toString("base64")}`;
    const res = await fetch(base, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method, params: params || {}, id: requestId }) });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || "Kodi RPC error");
    return data.result;
  }

  async function activePlayerId() {
    const players = await rpc("Player.GetActivePlayers");
    return players && players[0] ? players[0].playerid : null;
  }

  ctx.onAction("playPause", async () => {
    try {
      const id = await activePlayerId();
      if (id !== null) await rpc("Player.PlayPause", { playerid: id });
      refresh();
    } catch (err) {
      ctx.log(`playPause failed: ${err.message}`);
    }
  });
  ctx.onAction("stop", async () => {
    try {
      const id = await activePlayerId();
      if (id !== null) await rpc("Player.Stop", { playerid: id });
      refresh();
    } catch (err) {
      ctx.log(`stop failed: ${err.message}`);
    }
  });
  ctx.onAction("setVolume", async ({ value }) => {
    try {
      await rpc("Application.SetVolume", { volume: Math.max(0, Math.min(100, Math.round(value))) });
      refresh();
    } catch (err) {
      ctx.log(`setVolume failed: ${err.message}`);
    }
  });
  ctx.onAction("mute", async () => {
    try {
      await rpc("Application.SetMute", { mute: true });
      refresh();
    } catch (err) {
      ctx.log(`mute failed: ${err.message}`);
    }
  });
  ctx.onAction("unmute", async () => {
    try {
      await rpc("Application.SetMute", { mute: false });
      refresh();
    } catch (err) {
      ctx.log(`unmute failed: ${err.message}`);
    }
  });
  ctx.onAction("goHome", () => rpc("Input.Home").catch((err) => ctx.log(`goHome failed: ${err.message}`)));
  ctx.onAction("notify", ({ title, message }) => rpc("GUI.ShowNotification", { title, message }).catch((err) => ctx.log(`notify failed: ${err.message}`)));

  async function refresh() {
    try {
      const id = await activePlayerId();
      ctx.setState("player.active", id !== null);
      const props = await rpc("Application.GetProperties", { properties: ["volume", "muted"] });
      ctx.setState("player.volume", props.volume);
      ctx.setState("player.muted", Boolean(props.muted));
    } catch (err) {
      ctx.log(`Refresh failed: ${err.message}`);
    }
  }
  ctx.onAction("refresh", () => refresh());

  return {
    onConnect() {
      refresh();
    },
    onDisconnect() {},
  };
}

module.exports = { create };
