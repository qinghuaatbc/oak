"use strict";
// LG webOS TV driver over LG's SSAP (Second Screen Application Protocol)
// WebSocket API - not officially published by LG for consumers, but
// extremely stable and consistently documented across community
// libraries (lgtv2, aiopylgtv/bscpylgtv) for many webOS TV generations,
// moderate-high confidence. Manages its own WebSocket via the sandbox's
// `WebSocket` global directly (manifest declares "http" transport just
// so the loader calls onConnect immediately - see ../xiaomi-miio's header
// comment for this same pattern) rather than the runtime's plain-TCP
// Connection.
//
// Pairing: the FIRST connection triggers an on-screen "Allow this device
// to connect?" prompt on the TV - accept it once, and the resulting
// client-key (logged here) should be copied into the clientKey setting
// so future connects skip the prompt entirely.
const REGISTER_PAYLOAD = {
  forcePairing: false,
  pairingType: "PROMPT",
  manifest: {
    manifestVersion: 1,
    permissions: [
      "LAUNCH", "LAUNCH_WEBAPP", "APP_TO_APP", "CLOSE", "TEST_OPEN", "TEST_PROTECTED",
      "CONTROL_AUDIO", "CONTROL_DISPLAY", "CONTROL_INPUT_JOYSTICK", "CONTROL_INPUT_MEDIA_RECORDING",
      "CONTROL_INPUT_MEDIA_PLAYBACK", "CONTROL_INPUT_TV", "CONTROL_POWER", "READ_APP_STATUS",
      "READ_CURRENT_CHANNEL", "READ_INPUT_DEVICE_LIST", "READ_NETWORK_STATE", "READ_RUNNING_APPS",
      "READ_TV_CHANNEL_LIST", "WRITE_NOTIFICATION_TOAST", "READ_POWER_STATE", "READ_COUNTRY_INFO",
    ],
  },
};

function create(ctx) {
  const host = ctx.config.connection.host;
  const port = ctx.config.connection.port || 3000;

  let ws = null;
  let requestId = 0;

  function send(type, uri, payload) {
    if (!ws || ws.readyState !== ws.OPEN) return;
    requestId += 1;
    const msg = { type, id: `oak_${requestId}`, ...(uri ? { uri } : {}), payload: payload || {} };
    ws.send(JSON.stringify(msg));
  }
  function request(uri, payload) {
    send("request", uri, payload);
  }

  ctx.onAction("turnOff", () => request("ssap://system/turnOff"));
  ctx.onAction("setVolume", ({ value }) => request("ssap://audio/setVolume", { volume: Math.max(0, Math.min(100, Math.round(value))) }));
  ctx.onAction("mute", () => request("ssap://audio/setMute", { mute: true }));
  ctx.onAction("unmute", () => request("ssap://audio/setMute", { mute: false }));
  ctx.onAction("launchApp", ({ appId }) => request("ssap://com.webos.applicationManager/launch", { id: appId }));
  ctx.onAction("switchInput", ({ inputId }) => request("ssap://tv/switchInput", { inputId }));

  return {
    onConnect() {
      ws = new WebSocket(`ws://${host}:${port}`);
      ws.on("open", () => {
        send("register", null, { ...REGISTER_PAYLOAD, "client-key": ctx.config.settings.clientKey || undefined });
      });
      ws.on("message", (data) => {
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (msg.type === "registered") {
          ctx.setState("tv.paired", true);
          if (msg.payload && msg.payload["client-key"]) {
            ctx.log(`Paired. Copy this into the clientKey setting: ${msg.payload["client-key"]}`);
          }
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
