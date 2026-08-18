"use strict";
// Roborock vacuum driver over the miIO protocol - Roborock's early
// (and still widely deployed) product line was built on Xiaomi's miIO
// ecosystem, so this is the SAME wire protocol as ../xiaomi-miio (that
// driver's own header comment covers the handshake/AES/checksum details
// and this file's confidence level - moderate, worth verifying against a
// real device), just with Roborock's vacuum-specific miIO method names
// (app_start/app_stop/app_pause/app_charge/get_status) in place of
// Xiaomi's light methods. The device token is still obtained the same
// way (extracted via account tooling, not visible in either app's UI
// directly).
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
    if (!key || deviceId === null) return;
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
    token.copy(header, 16);
    const checksum = crypto.createHash("md5").update(Buffer.concat([header, encrypted])).digest();
    checksum.copy(header, 16);

    socket.send(Buffer.concat([header, encrypted]), port, host);
  }

  function handlePacket(msg) {
    if (msg.length === 32 && deviceId === null) {
      deviceId = msg.slice(8, 12);
      stamp = msg.readUInt32BE(12);
      stampReceivedAt = Date.now();
      ctx.log("miIO handshake complete");
      if (helloTimer) helloTimer.cancel();
      callMethod("get_status", []);
      return;
    }
    if (msg.length <= 32 || !key) return;
    try {
      const decrypted = decrypt(msg.slice(32));
      const result = JSON.parse(decrypted.toString("utf8"));
      ctx.emitEvent("response", { result });
      const status = Array.isArray(result.result) && result.result[0];
      if (status && typeof status === "object") {
        if (status.state !== undefined) ctx.setState("robot.state", status.state);
        if (status.battery !== undefined) ctx.setState("robot.batteryPercent", status.battery);
      }
    } catch (err) {
      ctx.log(`Failed to decode Roborock response: ${err.message}`);
    }
  }

  ctx.onAction("start", () => callMethod("app_start", []));
  ctx.onAction("pause", () => callMethod("app_pause", []));
  ctx.onAction("stop", () => callMethod("app_stop", []));
  ctx.onAction("dock", () => callMethod("app_charge", []));

  return {
    onConnect() {
      socket = dgram.createSocket("udp4");
      socket.on("message", handlePacket);
      socket.on("error", (err) => ctx.log(`UDP socket error: ${err.message}`));
      socket.bind(() => {
        sendHello();
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
