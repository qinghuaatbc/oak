"use strict";
// Xiaomi Mi Home / miIO driver - UDP port 54321, reverse-engineered
// protocol (Xiaomi has never published it) that every independent
// open-source implementation (python-miio, homebridge-miot, etc.) has
// converged on. This is genuinely UDP + AES-128-CBC, which is why it
// manages its own dgram socket via Node's core `dgram`/`crypto` modules
// (available through the sandbox's real require(), same escape hatch
// this project's eisy driver already uses for its own extra WebSocket)
// rather than the manifest's declared "http" transport - declared that
// way only so the loader calls onConnect immediately with no real TCP/
// HTTP dependency (see runtime/loader.js's DriverInstance.start(): a
// connection-less transport invokes onConnect right away), the same
// reason zwave-js/eisy declare a transport they don't literally use.
//
// CONFIDENCE NOTE: the packet header layout (magic/length/device
// id/stamp/checksum) and the handshake ("hello") packet are recalled with
// reasonable confidence - they've been stable across years of
// independent reimplementations. The exact checksum placement (the
// 16-byte token substituted into the checksum field before MD5-ing the
// whole header+payload, per python-miio) is the part most worth
// double-checking against a real device before trusting this - unlike a
// wrong protobuf message type (which just stalls safely), a UDP protocol
// with no ack/retry means a wrong request silently gets no response, so
// this is not yet verified against real hardware, same disclaimer as any
// first-draft driver.
const dgram = require("dgram");
const crypto = require("crypto");

const HELLO_PACKET = Buffer.concat([Buffer.from([0x21, 0x31, 0x00, 0x20]), Buffer.alloc(28, 0xff)]);

function create(ctx) {
  const host = ctx.config.connection.host;
  const port = ctx.config.connection.port || 54321;
  const token = Buffer.from(ctx.config.settings.token || "", "hex");
  const key = token.length === 16 ? crypto.createHash("md5").update(token).digest() : null;
  const iv = key ? crypto.createHash("md5").update(Buffer.concat([key, token])).digest() : null;

  let socket = null;
  let deviceId = null;
  let stamp = 0;
  let stampReceivedAt = 0;
  let requestId = 0;
  let helloTimer = null;

  function encrypt(jsonBuf) {
    const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
    return Buffer.concat([cipher.update(jsonBuf), cipher.final()]);
  }
  function decrypt(buf) {
    const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
    return Buffer.concat([decipher.update(buf), decipher.final()]);
  }

  function sendHello() {
    socket.send(HELLO_PACKET, port, host);
  }

  function callMethod(method, params) {
    if (!key || deviceId === null) return; // no token configured, or handshake hasn't completed yet
    requestId += 1;
    const body = Buffer.from(JSON.stringify({ id: requestId, method, params: params || [] }), "utf8");
    const encrypted = encrypt(body);
    const currentStamp = stamp + Math.floor((Date.now() - stampReceivedAt) / 1000);

    const header = Buffer.alloc(32);
    header.writeUInt16BE(0x2131, 0);
    header.writeUInt16BE(32 + encrypted.length, 2);
    header.writeUInt32BE(0, 4);
    deviceId.copy(header, 8);
    header.writeUInt32BE(currentStamp, 12);
    token.copy(header, 16); // checksum field temporarily holds the token itself, per miIO's construction
    const checksum = crypto.createHash("md5").update(Buffer.concat([header, encrypted])).digest();
    checksum.copy(header, 16); // ...then gets replaced with MD5(header-with-token + payload)

    socket.send(Buffer.concat([header, encrypted]), port, host);
  }

  function handlePacket(msg) {
    if (msg.length === 32 && deviceId === null) {
      // Handshake response: device id + current stamp, needed for every
      // subsequent request's header.
      deviceId = msg.slice(8, 12);
      stamp = msg.readUInt32BE(12);
      stampReceivedAt = Date.now();
      ctx.log("miIO handshake complete");
      if (helloTimer) helloTimer.cancel();
      callMethod("miIO.info", []);
      return;
    }
    if (msg.length <= 32 || !key) return;
    const encrypted = msg.slice(32);
    try {
      const decrypted = decrypt(encrypted);
      const result = JSON.parse(decrypted.toString("utf8"));
      ctx.emitEvent("response", { result });
      if (Array.isArray(result.result) && result.result[0] === "ok") {
        // Most miIO set_* methods just ack ["ok"] - the actual state is
        // whatever we asked for, since there's no separate push/event
        // channel in this protocol worth tracking here.
      }
    } catch (err) {
      ctx.log(`Failed to decode miIO response: ${err.message}`);
    }
  }

  ctx.onAction("turnOn", () => callMethod("set_power", ["on"]));
  ctx.onAction("turnOff", () => callMethod("set_power", ["off"]));
  ctx.onAction("setBrightness", ({ value }) => callMethod("set_bright", [Math.max(0, Math.min(100, Math.round(value)))]));
  ctx.onAction("call", ({ method, params }) => {
    let parsed = [];
    try {
      parsed = params ? JSON.parse(params) : [];
    } catch {
      /* ignore malformed params, call with none */
    }
    callMethod(method, parsed);
  });

  return {
    onConnect() {
      socket = dgram.createSocket("udp4");
      socket.on("message", handlePacket);
      socket.on("error", (err) => ctx.log(`UDP socket error: ${err.message}`));
      socket.bind(() => {
        sendHello();
        // The handshake packet is UDP (no delivery guarantee) - retry
        // every 2s until a 32-byte response arrives and deviceId is set.
        helloTimer = ctx.clock.every(2000, () => {
          if (deviceId === null) sendHello();
        });
      });
    },
    onDisconnect() {
      if (helloTimer) helloTimer.cancel();
      if (socket) socket.close();
      deviceId = null;
    },
  };
}

module.exports = { create };
