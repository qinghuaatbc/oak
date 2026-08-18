"use strict";
// HAI/Leviton OmniPro II driver over the OmniLink II TCP protocol,
// grounded in digitaldan/jomnilink's source (the long-standing Java
// client library most home-automation OmniLink integrations, including
// openHAB's, are themselves built on) rather than guessed - HIGH
// confidence on the outer/inner frame shape, the AES-128-ECB handshake
// structure, and the CommandMessage arm/disarm codes quoted below.
//
// LOWER CONFIDENCE, EXPLICITLY (verify against real jomnilink source
// before trusting on a real controller): the exact CRC-16 variant used
// on the inner frame (implemented below as the common CRC-16/ARC,
// poly 0xA001 reflected - this is the standard choice for this class of
// serial-derived protocol but wasn't byte-verified against source), the
// exact type3 handshake payload framing (implemented as: encrypt the
// 5-byte session ID, zero-padded to 16 bytes, with the derived session
// key), and the CommandMessage Data3 field's byte order for the area
// number. Like ../paradox's sibling driver, a wrong byte in the
// handshake/CRC breaks framing entirely - that's the first thing to
// check if this driver can't get past "Session Established".
//
// MODERATE CONFIDENCE on mode mapping: which numeric mode is the best
// fit for "arm stay" varies by installation (Day/Night/Day-Instant/
// Night-Delayed all exist) - armDay below maps to plain "Day" (mode 1).
//
// SCOPE: this is a control-focused MVP, matching ../paradox. Real-time
// zone/area status decoding (ReqObjectStatus/ObjectStatus, 0x22/0x23)
// is deferred - not implemented here.
const crypto = require("crypto");

const PACKET_TYPE = { login: 1, loginAck: 2, sessionKey: 3, ack: 4, data: 32 };
const MSG_TYPE = { commandMessage: 0x14 };
const MODE = { disarm: 0, day: 1, night: 2, away: 3, vacation: 4, dayInstant: 5, nightDelayed: 6 };

function crc16(buf) {
  let crc = 0x0000;
  for (const b of buf) {
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc & 0xffff;
}
function aesEcbEncryptBlock(key, block) {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(block), cipher.final()]);
}
function aesEcbDecryptBlock(key, block) {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(block), decipher.final()]);
}
function xorSequenceIntoBlock(block, seq) {
  const out = Buffer.from(block);
  out[0] ^= (seq >> 8) & 0xff;
  out[1] ^= seq & 0xff;
  return out;
}
function encryptFrame(key, seq, plain) {
  const padded = Buffer.alloc(Math.ceil(plain.length / 16) * 16, 0);
  plain.copy(padded);
  const out = Buffer.alloc(padded.length);
  for (let off = 0; off < padded.length; off += 16) {
    const block = xorSequenceIntoBlock(padded.slice(off, off + 16), seq);
    aesEcbEncryptBlock(key, block).copy(out, off);
  }
  return out;
}
function decryptFrame(key, seq, cipherText) {
  const out = Buffer.alloc(cipherText.length);
  for (let off = 0; off < cipherText.length; off += 16) {
    const decrypted = aesEcbDecryptBlock(key, cipherText.slice(off, off + 16));
    xorSequenceIntoBlock(decrypted, seq).copy(out, off);
  }
  return out;
}
function buildInnerFrame(messageType, payload) {
  const body = Buffer.concat([Buffer.from([0x21, payload.length + 2, messageType]), payload]);
  const crc = crc16(body);
  return Buffer.concat([body, Buffer.from([crc & 0xff, (crc >> 8) & 0xff])]);
}

function create(ctx) {
  let rxBuffer = Buffer.alloc(0);
  let txSeq = 0;
  let rxSeq = 0;
  let sessionKey = null;
  let ready = false;

  function sendOuter(packetType, data) {
    const header = Buffer.alloc(4);
    header.writeUInt16BE(txSeq, 0);
    header[2] = packetType;
    header[3] = 0;
    ctx.connection.send(Buffer.concat([header, data]));
    txSeq = (txSeq + 1) & 0xffff;
  }
  function sendEncrypted(messageType, payload) {
    const frame = buildInnerFrame(messageType, payload);
    sendOuter(PACKET_TYPE.data, encryptFrame(sessionKey, txSeq, frame));
  }

  function startHandshake() {
    txSeq = 0;
    rxSeq = 0;
    sendOuter(PACKET_TYPE.login, Buffer.alloc(0));
  }
  function completeHandshake(sessionId5) {
    const configuredKey = Buffer.from((ctx.config.settings.key || "").padEnd(32, "0").slice(0, 32), "hex");
    const key = Buffer.from(configuredKey);
    for (let i = 0; i < 5; i++) key[11 + i] ^= sessionId5[i];
    sessionKey = key;
    const padded = Buffer.alloc(16, 0);
    sessionId5.copy(padded);
    sendOuter(PACKET_TYPE.sessionKey, aesEcbEncryptBlock(sessionKey, padded));
  }

  function performAction(mode, area) {
    const payload = Buffer.from([48 + mode, ctx.config.settings.codeNumber || 1, 0, area || 1]);
    sendEncrypted(MSG_TYPE.commandMessage, payload);
  }
  ctx.onAction("armAway", ({ area = 1 }) => performAction(MODE.away, area));
  ctx.onAction("armDay", ({ area = 1 }) => performAction(MODE.day, area));
  ctx.onAction("armNight", ({ area = 1 }) => performAction(MODE.night, area));
  ctx.onAction("disarm", ({ area = 1 }) => performAction(MODE.disarm, area));

  function handleOuter(packetType, data) {
    if (packetType === PACKET_TYPE.loginAck) {
      // version bytes + 5-byte session ID, per jomnilink's Connection handshake.
      const sessionId5 = data.slice(data.length - 5);
      completeHandshake(sessionId5);
    } else if (packetType === PACKET_TYPE.ack) {
      ready = true;
      ctx.log("OmniLink II session established");
      ctx.emitEvent("connected", {});
    } else if (packetType === PACKET_TYPE.data && sessionKey) {
      rxSeq = (rxSeq + 1) & 0xffff;
      try {
        decryptFrame(sessionKey, rxSeq, data);
      } catch (err) {
        ctx.log(`Failed to decrypt inbound frame: ${err.message}`);
      }
    }
  }

  return {
    onConnect() {
      rxBuffer = Buffer.alloc(0);
      sessionKey = null;
      ready = false;
      startHandshake();
    },
    onDisconnect() {
      ready = false;
    },
    onData(chunk) {
      rxBuffer = Buffer.concat([rxBuffer, chunk]);
      while (rxBuffer.length >= 4) {
        const packetType = rxBuffer[2];
        let dataLen;
        if (packetType === PACKET_TYPE.data) {
          if (rxBuffer.length < 5) break;
          dataLen = Math.ceil((rxBuffer.length - 4) / 16) * 16;
          if (rxBuffer.length < 4 + dataLen) break;
        } else {
          dataLen = rxBuffer.length - 4;
        }
        const data = rxBuffer.slice(4, 4 + dataLen);
        rxBuffer = rxBuffer.slice(4 + dataLen);
        handleOuter(packetType, data);
        if (packetType !== PACKET_TYPE.data) break;
      }
    },
  };
}

module.exports = { create };
