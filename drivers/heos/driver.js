"use strict";
// Denon HEOS driver over their own OFFICIALLY published "HEOS CLI
// Protocol" (Denon publishes this PDF for integrators) - real, official,
// high confidence. Plain-text "heos://" command URIs terminated with
// \r\n over a persistent TCP socket (port 1255), JSON responses.
function create(ctx) {
  let rxBuffer = "";

  function send(command, params) {
    const query = params ? "?" + new URLSearchParams(params).toString() : "";
    ctx.connection.send(`heos://${command}${query}\r\n`);
  }

  function handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const heos = msg.heos;
    if (!heos) return;
    if (heos.command === "player/get_players" && msg.payload) {
      const players = msg.payload.map((p) => ({ id: p.pid, name: p.name }));
      ctx.setState("discovery.players", JSON.stringify(players));
    } else if (heos.command === "player/get_play_state" && heos.message) {
      const params = new URLSearchParams(heos.message);
      ctx.setState("player.state", params.get("state"));
    }
  }

  ctx.onAction("play", () => send("player/set_play_state", { pid: ctx.config.settings.playerId, state: "play" }));
  ctx.onAction("pause", () => send("player/set_play_state", { pid: ctx.config.settings.playerId, state: "pause" }));
  ctx.onAction("setVolume", ({ value }) => send("player/set_volume", { pid: ctx.config.settings.playerId, level: Math.max(0, Math.min(100, Math.round(value))) }));
  ctx.onAction("mute", () => send("player/set_mute", { pid: ctx.config.settings.playerId, state: "on" }));
  ctx.onAction("unmute", () => send("player/set_mute", { pid: ctx.config.settings.playerId, state: "off" }));
  ctx.onAction("discoverPlayers", () => send("player/get_players"));

  return {
    onConnect() {
      rxBuffer = "";
      send("player/get_players");
    },
    onDisconnect() {},
    onData(chunk) {
      rxBuffer += chunk.toString("utf8");
      let idx;
      while ((idx = rxBuffer.indexOf("\r\n")) !== -1) {
        const line = rxBuffer.slice(0, idx);
        rxBuffer = rxBuffer.slice(idx + 2);
        if (line.length) handleLine(line);
      }
    },
  };
}

module.exports = { create };
