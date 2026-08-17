"use strict";
// Squeezebox / Logitech Media Server driver over LMS's own published
// JSON-RPC API (Logitech/Slim Devices documented this themselves as the
// "SqueezeCenter/LMS CLI", exposed over HTTP as jsonrpc.js - the open
// source project keeps this documented). High confidence.
const POLL_MS = 15000;

function create(ctx) {
  const host = ctx.config.connection.host;
  const port = ctx.config.connection.port || 9000;
  const base = `http://${host}:${port}/jsonrpc.js`;
  let requestId = 0;
  let pollHandle = null;

  async function request(playerId, command) {
    requestId += 1;
    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: requestId, method: "slim.request", params: [playerId || "", command] }),
    });
    const data = await res.json();
    return data.result;
  }
  function playerCommand(command) {
    return request(ctx.config.settings.playerId, command);
  }

  ctx.onAction("turnOn", () => playerCommand(["power", "1"]).then(refresh));
  ctx.onAction("turnOff", () => playerCommand(["power", "0"]).then(refresh));
  ctx.onAction("play", () => playerCommand(["play"]).then(refresh));
  ctx.onAction("pause", () => playerCommand(["pause"]).then(refresh));
  ctx.onAction("next", () => playerCommand(["playlist", "index", "+1"]));
  ctx.onAction("previous", () => playerCommand(["playlist", "index", "-1"]));
  ctx.onAction("setVolume", ({ value }) => playerCommand(["mixer", "volume", String(Math.max(0, Math.min(100, Math.round(value))))]).then(refresh));

  ctx.onAction("discoverPlayers", async () => {
    try {
      const result = await request("", ["players", "0", "100"]);
      const players = (result.players_loop || []).map((p) => ({ id: p.playerid, name: p.name }));
      ctx.setState("discovery.players", JSON.stringify(players));
    } catch (err) {
      ctx.log(`discoverPlayers failed: ${err.message}`);
    }
  });

  async function refresh() {
    if (!ctx.config.settings.playerId) return;
    try {
      const result = await playerCommand(["status", "-", "1"]);
      ctx.setState("player.on", result.power === 1);
      ctx.setState("player.volume", result["mixer volume"]);
    } catch (err) {
      ctx.log(`Refresh failed: ${err.message}`);
    }
  }
  ctx.onAction("refresh", () => refresh());

  return {
    onConnect() {
      refresh();
      pollHandle = ctx.clock.every(POLL_MS, refresh);
    },
    onDisconnect() {
      if (pollHandle) pollHandle.cancel();
    },
  };
}

module.exports = { create };
