"use strict";
// Govee LAN API driver - distinct from ../govee/driver.js (which uses
// Govee's CLOUD REST API). Govee publishes an official "Govee LAN API"
// PDF for select device models (must be enabled per-device in the Govee
// app first) - a local UDP protocol, no cloud round-trip needed. Control
// commands go to the device's own port 4003; status requests/responses
// use ports 4001/4002. Manages its own dgram socket (manifest declares
// "http" transport just so the loader calls onConnect immediately - see
// ../xiaomi-miio's header comment for this pattern).
//
// KNOWN LIMITATION: the protocol expects status responses on a FIXED
// local port (4002), not whatever port the request happened to be sent
// from - so only ONE govee-lan instance per host can actually receive
// status responses; a second instance's bind() fails (caught below,
// logged) and that instance simply won't receive status pushes, though
// outbound control commands still work since those don't need the bound
// listener. A real constraint of the protocol itself, not something
// addressable from one driver instance in isolation.
const dgram = require("dgram");
const CONTROL_PORT = 4003;
const STATUS_PORT = 4001;

function create(ctx) {
  const host = ctx.config.connection.host;
  let socket = null;

  function sendControl(cmd, data) {
    if (!socket) return;
    const msg = Buffer.from(JSON.stringify({ msg: { cmd, data: data || {} } }));
    socket.send(msg, CONTROL_PORT, host);
  }
  function sendStatusQuery() {
    if (!socket) return;
    const msg = Buffer.from(JSON.stringify({ msg: { cmd: "devStatus", data: {} } }));
    socket.send(msg, STATUS_PORT, host);
  }

  ctx.onAction("turnOn", () => sendControl("turn", { value: 1 }));
  ctx.onAction("turnOff", () => sendControl("turn", { value: 0 }));
  ctx.onAction("setBrightness", ({ value }) => sendControl("brightness", { value: Math.max(1, Math.min(100, Math.round(value))) }));
  ctx.onAction("refresh", () => sendStatusQuery());

  return {
    onConnect() {
      socket = dgram.createSocket("udp4");
      socket.on("message", (msg) => {
        try {
          const data = JSON.parse(msg.toString());
          const status = data.msg && data.msg.data;
          if (!status) return;
          if (status.onOff !== undefined) ctx.setState("device.on", status.onOff === 1);
          if (status.brightness !== undefined) ctx.setState("device.brightness", status.brightness);
        } catch {
          /* ignore malformed response */
        }
      });
      socket.on("error", (err) => ctx.log(`UDP socket error (another instance already bound to port ${STATUS_PORT + 1}?): ${err.message}`));
      socket.bind(STATUS_PORT + 1, () => sendStatusQuery());
    },
    onDisconnect() {
      if (socket) socket.close();
      socket = null;
    },
  };
}

module.exports = { create };
