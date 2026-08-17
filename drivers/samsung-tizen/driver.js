"use strict";
// Samsung Tizen TV driver over its local WebSocket remote-control API -
// not officially published by Samsung for consumers, but stable and
// consistently documented across community libraries (samsung-tv-ws-api,
// samsungctl) for many TV model years, moderate-high confidence.
//
// Pairing: the first connection shows an on-screen "Allow this device to
// connect?" prompt - accept it once, and the token this driver logs
// (from the ms.channel.connect response) should be copied into the
// token setting so future connects skip the prompt.
function create(ctx) {
  const host = ctx.config.connection.host;
  const port = ctx.config.connection.port || 8001;
  let ws = null;

  function wsUrl() {
    const name = Buffer.from("Oak").toString("base64");
    const token = ctx.config.settings.token;
    return `ws://${host}:${port}/api/v2/channels/samsung.remote.control?name=${name}${token ? `&token=${token}` : ""}`;
  }
  function sendKey(key) {
    if (!ws || ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ method: "ms.remote.control", params: { Cmd: "Click", DataOfCmd: key, Option: "false", TypeOfRemote: "SendRemoteKey" } }));
  }

  ctx.onAction("turnOff", () => sendKey("KEY_POWER"));
  ctx.onAction("volumeUp", () => sendKey("KEY_VOLUP"));
  ctx.onAction("volumeDown", () => sendKey("KEY_VOLDOWN"));
  ctx.onAction("mute", () => sendKey("KEY_MUTE"));
  ctx.onAction("pressKey", ({ key }) => sendKey(key));

  return {
    onConnect() {
      ws = new WebSocket(wsUrl());
      ws.on("message", (data) => {
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (msg.event === "ms.channel.connect") {
          ctx.setState("tv.paired", true);
          if (msg.data && msg.data.token) ctx.log(`Paired. Copy this into the token setting: ${msg.data.token}`);
          ctx.emitEvent("paired", {});
        }
      });
      ws.on("error", (err) => ctx.log(`Connection error: ${err.message}`));
      ws.on("close", () => ctx.setState("tv.paired", false));
    },
    onDisconnect() {
      if (ws) ws.terminate();
      ws = null;
    },
  };
}

module.exports = { create };
