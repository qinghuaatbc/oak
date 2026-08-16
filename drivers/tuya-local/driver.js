"use strict";
// Tuya local-network driver (protocol 3.3) for the Oak runtime.
//
// Tuya's local protocol has no public spec from Tuya itself - what's
// implemented here is the reverse-engineered wire format that every
// independent open-source Tuya library (tuyapi, tinytuya, python-tuya,
// homebridge-tuya) has converged on and republished consistently for
// years, which is why this is written with more confidence than a truly
// novel/obscure protocol would warrant. Scoped to protocol 3.3 (a static
// per-device "local key" + AES-128-ECB) - NOT 3.4/3.5, which replaced the
// static key with a session-key negotiation handshake this driver does
// not implement. Still genuinely unverified against a real device this
// session - treat as a plausible starting point, same disclaimer as any
// first-draft driver here.
//
// A device's `deviceId` and `localKey` are NOT discoverable from the LAN
// device itself - they only come from a (free) Tuya IoT Cloud developer
// account linked to the same Smart Life/Tuya app account the device was
// paired through.
//
// Packet: 0x000055AA + seqno(4) + command(4) + length(4) + payload + crc32(4) + 0x0000AA55
// Payload (3.3): "3.3" + 12 NUL bytes, then AES-128-ECB(localKey) of the
// JSON command, PKCS7-padded.
const crypto = require("crypto");

const PREFIX = 0x000055aa;
const SUFFIX = 0x0000aa55;
const CMD = { CONTROL: 7, STATUS: 8, HEART_BEAT: 9, DP_QUERY: 10 };

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pkcs7Pad(buf, blockSize) {
  const padLen = blockSize - (buf.length % blockSize);
  return Buffer.concat([buf, Buffer.alloc(padLen, padLen)]);
}
function pkcs7Unpad(buf) {
  const padLen = buf[buf.length - 1];
  return buf.slice(0, buf.length - padLen);
}

function create(ctx) {
  const key = String(ctx.config.settings.localKey || "");
  let rxBuffer = Buffer.alloc(0);
  let seqno = 0;
  let heartbeat = null;

  function encrypt(jsonStr) {
    const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(pkcs7Pad(Buffer.from(jsonStr, "utf8"), 16)), cipher.final()]);
  }
  function decrypt(buf) {
    const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
    decipher.setAutoPadding(false);
    return pkcs7Unpad(Buffer.concat([decipher.update(buf), decipher.final()]));
  }

  function sendPacket(command, payloadObj) {
    const json = Buffer.from(JSON.stringify(payloadObj), "utf8");
    const versionHeader = Buffer.concat([Buffer.from("3.3", "utf8"), Buffer.alloc(12, 0)]);
    const payload = Buffer.concat([versionHeader, encrypt(json.toString("utf8"))]);
    const length = payload.length + 4 + 4; // + crc32 + suffix
    const header = Buffer.alloc(16);
    header.writeUInt32BE(PREFIX, 0);
    header.writeUInt32BE(seqno++, 4);
    header.writeUInt32BE(command, 8);
    header.writeUInt32BE(length, 12);
    const withoutCrc = Buffer.concat([header, payload]);
    const crc = crc32(withoutCrc);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc, 0);
    const suffixBuf = Buffer.alloc(4);
    suffixBuf.writeUInt32BE(SUFFIX, 0);
    ctx.connection.send(Buffer.concat([withoutCrc, crcBuf, suffixBuf]));
  }

  function baseFields() {
    return { devId: ctx.config.settings.deviceId, uid: ctx.config.settings.deviceId, t: String(Math.floor(Date.now() / 1000)) };
  }
  function setDps(dps) {
    sendPacket(CMD.CONTROL, { ...baseFields(), dps });
  }
  function query() {
    sendPacket(CMD.DP_QUERY, baseFields());
  }

  function applyDps(dps) {
    const switchDp = ctx.config.settings.switchDp || "1";
    const brightnessDp = ctx.config.settings.brightnessDp || "2";
    if (switchDp in dps) ctx.setState("power.on", Boolean(dps[switchDp]));
    if (brightnessDp in dps) ctx.setState("power.brightness", Number(dps[brightnessDp]));
    ctx.emitEvent("statusUpdate", { dps });
  }

  function handlePacket(buf) {
    const command = buf.readUInt32BE(8);
    const length = buf.readUInt32BE(12);
    const payload = buf.slice(16, 16 + length - 8); // exclude crc32+suffix already accounted for in length
    if (command !== CMD.STATUS && command !== CMD.CONTROL && command !== CMD.DP_QUERY) return;
    if (!payload.length) return;
    let jsonBuf = payload;
    // A 3.x reply's payload starts with the same "3.x"+12-NUL version
    // header as an outbound packet ONLY when the device includes it -
    // not every reply does. Strip it if present before decrypting.
    if (payload.slice(0, 3).toString("utf8") === "3.3" || payload.slice(0, 3).toString("utf8") === "3.1") {
      jsonBuf = payload.slice(15);
    }
    try {
      const decrypted = key ? decrypt(jsonBuf) : jsonBuf;
      const msg = JSON.parse(decrypted.toString("utf8"));
      if (msg.dps) applyDps(msg.dps);
    } catch (err) {
      ctx.log(`Failed to decode Tuya packet: ${err.message}`);
    }
  }

  ctx.onAction("turnOn", () => setDps({ [ctx.config.settings.switchDp || "1"]: true }));
  ctx.onAction("turnOff", () => setDps({ [ctx.config.settings.switchDp || "1"]: false }));
  ctx.onAction("setBrightness", ({ value }) => setDps({ [ctx.config.settings.brightnessDp || "2"]: value }));
  ctx.onAction("setDp", ({ dp, value }) => {
    let v = value;
    try {
      v = JSON.parse(value);
    } catch {
      /* keep as raw string - not every DP value is JSON (e.g. a plain string enum) */
    }
    setDps({ [dp]: v });
  });
  ctx.onAction("query", () => query());

  return {
    onConnect() {
      rxBuffer = Buffer.alloc(0);
      seqno = 0;
      query();
      heartbeat = ctx.clock.every(6000, () => sendPacket(CMD.HEART_BEAT, {}));
    },
    onDisconnect() {
      if (heartbeat) heartbeat.cancel();
    },
    onData(chunk) {
      rxBuffer = Buffer.concat([rxBuffer, chunk]);
      // A full packet needs at least the 16-byte header before its
      // declared length even makes sense to read.
      while (rxBuffer.length >= 16) {
        if (rxBuffer.readUInt32BE(0) !== PREFIX) {
          // Resync: drop one byte and look again, rather than getting
          // permanently stuck on a misaligned buffer.
          rxBuffer = rxBuffer.slice(1);
          continue;
        }
        const length = rxBuffer.readUInt32BE(12);
        const totalLen = 16 + length;
        if (rxBuffer.length < totalLen) break; // wait for the rest
        handlePacket(rxBuffer.slice(0, totalLen));
        rxBuffer = rxBuffer.slice(totalLen);
      }
    },
  };
}

module.exports = { create };
