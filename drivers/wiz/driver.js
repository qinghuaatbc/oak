"use strict";
// WiZ (Signify) driver over its own local UDP JSON protocol (port 38899,
// no auth, no encryption) - not officially published, but simple and
// extremely stable across community documentation (pywizlight), high
// confidence. Manages its own dgram socket (manifest declares "http"
// transport just so the loader calls onConnect immediately - see
// ../xiaomi-miio's header comment for this pattern).
const dgram = require("dgram");

function create(ctx) {
  const host = ctx.config.connection.host;
  const port = ctx.config.connection.port || 38899;
  let socket = null;

  function send(method, params) {
    if (!socket) return;
    const msg = Buffer.from(JSON.stringify({ method, params: params || {} }));
    socket.send(msg, port, host);
  }

  ctx.onAction("turnOn", () => send("setPilot", { state: true }));
  ctx.onAction("turnOff", () => send("setPilot", { state: false }));
  ctx.onAction("setBrightness", ({ value }) => send("setPilot", { state: true, dimming: Math.max(1, Math.min(100, Math.round(value))) }));
  ctx.onAction("refresh", () => send("getPilot", {}));

  return {
    onConnect() {
      socket = dgram.createSocket("udp4");
      socket.on("message", (msg) => {
        try {
          const data = JSON.parse(msg.toString());
          const result = data.result;
          if (!result) return;
          if (result.state !== undefined) ctx.setState("bulb.on", result.state);
          if (result.dimming !== undefined) ctx.setState("bulb.brightness", result.dimming);
        } catch {
          /* ignore malformed response */
        }
      });
      socket.on("error", (err) => ctx.log(`UDP socket error: ${err.message}`));
      socket.bind(() => send("getPilot", {}));
    },
    onDisconnect() {
      if (socket) socket.close();
      socket = null;
    },
  };
}

module.exports = { create };
