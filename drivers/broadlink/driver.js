"use strict";
// Broadlink IR/RF blaster driver - UDP, reverse-engineered protocol (like
// Xiaomi Miio, see ../xiaomi-miio/driver.js's header comment for why this
// manages its own dgram socket instead of using the manifest's declared
// "http" transport). Fixed default AES key/IV and the two-command shape
// (0x65 = auth, 0x6a = IR/RF send, 0x6a with different payload = enter
// learning mode / read learned code) are recalled with reasonable
// confidence - they're published identically across every independent
// Broadlink library (python-broadlink, node-broadlink, etc.) and haven't
// changed in years. LOWEST-confidence part of this driver: the exact
// byte offsets inside the 80-byte auth payload (mostly reserved/zero
// bytes plus a device-name/MAC field) - double-check against
// python-broadlink's `Device.auth()` before trusting this against real
// hardware. Not verified against a real device this session.
const dgram = require("dgram");
const crypto = require("crypto");

const DEFAULT_KEY = Buffer.from("0976283 43fe99e23765c1513accf8b02".replace(/ /g, ""), "hex");
const DEFAULT_IV = Buffer.from("562e17996d093d28ddb3ba695a2e6f58", "hex");

function create(ctx) {
  const host = ctx.config.connection.host;
  const port = ctx.config.connection.port || 80;
  const deviceType = Number(ctx.config.settings.deviceType) || 0x2712;

  let socket = null;
  let count = Math.floor(Math.random() * 0xffff);
  let key = DEFAULT_KEY;
  let iv = DEFAULT_IV;
  let deviceId = Buffer.alloc(4, 0);
  let authenticated = false;

  function encrypt(payload, useKey, useIv) {
    const cipher = crypto.createCipheriv("aes-128-cbc", useKey, useIv);
    cipher.setAutoPadding(false);
    const blockLen = Math.ceil(payload.length / 16) * 16;
    const padded = Buffer.concat([payload, Buffer.alloc(blockLen - payload.length, 0)]);
    return Buffer.concat([cipher.update(padded), cipher.final()]);
  }
  function decrypt(payload, useKey, useIv) {
    const decipher = crypto.createDecipheriv("aes-128-cbc", useKey, useIv);
    decipher.setAutoPadding(false);
    return Buffer.concat([decipher.update(payload), decipher.final()]);
  }

  function buildPacket(command, payloadPlain, useKey, useIv) {
    count = (count + 1) & 0xffff;
    const encrypted = encrypt(payloadPlain, useKey, useIv);
    const header = Buffer.alloc(0x38);
    header.writeUInt16LE(0x5aa5, 0); // fixed sync bytes every packet starts with
    header.writeUInt16LE(0x0000, 4);
    header.writeUInt16LE(0x0000, 6);
    header.writeUInt8(deviceType & 0xff, 0x24);
    header.writeUInt8((deviceType >> 8) & 0xff, 0x25);
    header.writeUInt16LE(command, 0x26);
    header.writeUInt16LE(count, 0x28);
    Buffer.alloc(6, 0).copy(header, 0x2a); // local MAC - left zeroed, not needed for a LAN-only send
    deviceId.copy(header, 0x30);
    // Broadlink's own non-standard running-sum "checksum" (seed 0xbeaf,
    // not a real CRC) over header+encrypted-payload, computed with the
    // checksum field itself still zero, then written back into the
    // header at 0x20-0x21 (little-endian) before sending.
    header.writeUInt16LE(0, 0x20);
    let checksum = 0xbeaf;
    for (const b of Buffer.concat([header, encrypted])) checksum = (checksum + b) & 0xffff;
    header.writeUInt16LE(checksum, 0x20);
    return Buffer.concat([header, encrypted]);
  }

  function auth() {
    const payload = Buffer.alloc(80, 0);
    payload[0x04] = 0x31;
    payload[0x05] = 0x31;
    payload[0x06] = 0x31;
    payload[0x07] = 0x31;
    payload[0x08] = 0x31;
    payload[0x09] = 0x31;
    payload[0x0a] = 0x31;
    payload[0x0b] = 0x31;
    payload[0x0c] = 0x31;
    payload[0x0d] = 0x31;
    payload[0x0e] = 0x31;
    payload[0x0f] = 0x31;
    payload[0x1e] = 0x01;
    payload[0x2d] = 0x01;
    Buffer.from("Oak", "utf8").copy(payload, 0x30);
    socket.send(buildPacket(0x65, payload, DEFAULT_KEY, DEFAULT_IV), port, host);
  }

  function sendIrCode(codeBuf) {
    if (!authenticated) {
      ctx.log("Not authenticated yet - cannot send code");
      return;
    }
    const payload = Buffer.concat([Buffer.from([0x02, 0x00, 0x00, 0x00]), codeBuf]);
    socket.send(buildPacket(0x6a, payload, key, iv), port, host);
  }

  function handlePacket(msg) {
    const command = msg.readUInt16LE(0x26);
    const encrypted = msg.slice(0x38);
    if (!authenticated && command === 0xe9) {
      // Auth response: device id (4 bytes) + a fresh 16-byte session key,
      // both inside the encrypted payload.
      const decrypted = decrypt(encrypted, DEFAULT_KEY, DEFAULT_IV);
      deviceId = decrypted.slice(0, 4);
      key = decrypted.slice(4, 20);
      iv = DEFAULT_IV;
      authenticated = true;
      ctx.log("Broadlink authenticated");
      ctx.emitEvent("authenticated", {});
      return;
    }
    if (command === 0xee || command === 0xef) {
      // Learning-mode read response - first 4 bytes of the decrypted
      // payload are a status/error code, the rest (if any) is the
      // learned IR code.
      try {
        const decrypted = decrypt(encrypted, key, iv);
        if (decrypted.length > 4) {
          const codeHex = decrypted.slice(4).toString("hex");
          ctx.setState("learned.code", codeHex);
          ctx.emitEvent("codeLearned", { hex: codeHex });
        }
      } catch (err) {
        ctx.log(`Failed to decode learned code: ${err.message}`);
      }
    }
  }

  ctx.onAction("sendCode", ({ name }) => {
    const stored = (ctx.config.settings.storedCodes || {})[name];
    if (!stored) {
      ctx.log(`No stored code named "${name}"`);
      return;
    }
    sendIrCode(Buffer.from(stored, "hex"));
  });
  ctx.onAction("sendRawHex", ({ hex }) => sendIrCode(Buffer.from(hex, "hex")));
  ctx.onAction("enterLearning", () => {
    if (!authenticated) return;
    socket.send(buildPacket(0x6a, Buffer.from([0x03, 0x00, 0x00, 0x00]), key, iv), port, host);
  });
  ctx.onAction("readLearned", () => {
    if (!authenticated) return;
    socket.send(buildPacket(0x6a, Buffer.from([0x04, 0x00, 0x00, 0x00]), key, iv), port, host);
  });

  return {
    onConnect() {
      socket = dgram.createSocket("udp4");
      socket.on("message", handlePacket);
      socket.on("error", (err) => ctx.log(`UDP socket error: ${err.message}`));
      socket.bind(() => auth());
    },
    onDisconnect() {
      if (socket) socket.close();
      authenticated = false;
    },
  };
}

module.exports = { create };
