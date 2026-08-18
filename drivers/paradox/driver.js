"use strict";
// Paradox security panel driver over an IP150/IP150+ module, grounded in
// the actively-maintained ParadoxAlarmInterface/pai project's source
// (paradox/connections/ip/commands.py, paradox/hardware/spectra_magellan/
// panel.py + parsers.py, paradox/hardware/common.py) rather than guessed -
// high confidence on the command bytes and checksum quoted below.
//
// LOWER CONFIDENCE, EXPLICITLY: the IP150 outer envelope's exact byte
// OFFSETS (this driver reconstructs a 16-byte header from the documented
// FIELD ORDER - sof, length, message_type, flags, command, sub_command,
// wt, sb, cryptor_code, not_used, sequence_id - padded out to 16 bytes,
// since the source uses a `construct` Struct whose exact per-field byte
// widths weren't fully captured) and the AES-256 key derivation from the
// module password (assumed here as right-zero-padded to 32 bytes) are
// reconstructed from field-name-level documentation, not a byte-exact
// dump of the Struct definition. If the IP150 handshake fails, THIS is
// the first thing to check against the real pai source before anything
// else - unlike a wrong command byte later in the session (which fails
// safely with a clean login error), a wrong envelope breaks framing
// entirely and nothing after it will work.
//
// The panel-level login (InitiateCommunication/StartCommunication/
// InitializeCommunication with the PC Password) and PerformAction
// (arm/disarm) command bytes ARE high confidence, quoted directly from
// source: action codes Stay_Arm=0x01, Full_Arm=0x04, Disarm=0x05; the PC
// Password authenticates the whole session, not individual commands (no
// PIN is sent per arm/disarm call, unlike ../paradox's sibling drivers
// dsc-powerseries/honeywell-vista which both take a code per-call).
const crypto = require("crypto");

const IP_CMD = { connect: 0xf0, keep_alive: 0xf2, upload_download: 0xf3, toggle_keep_alive: 0xf8 };
const MSG_TYPE = { ip_response: 1, serial_passthrough_response: 2, ip_request: 3, serial_passthrough_request: 4 };
const ACTION = { Stay_Arm: 0x01, Full_Arm: 0x04, Disarm: 0x05 };

function padKey32(password) {
  const buf = Buffer.from(password, "utf8");
  const out = Buffer.alloc(32, 0);
  buf.copy(out, 0, 0, Math.min(32, buf.length));
  return out;
}
function padTo16(buf, fillByte) {
  const rem = buf.length % 16;
  if (rem === 0) return buf;
  return Buffer.concat([buf, Buffer.alloc(16 - rem, fillByte)]);
}
function aesEcbEncrypt(key, data) {
  const cipher = crypto.createCipheriv("aes-256-ecb", key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padTo16(data, 0xee)), cipher.final()]);
}
function aesEcbDecrypt(key, data) {
  const decipher = crypto.createDecipheriv("aes-256-ecb", key, null);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}
function buildEnvelope({ messageType, command, encrypted, key }) {
  const header = Buffer.alloc(16, 0);
  header[0] = 0xaa; // sof
  // header[1..2] = length, filled in below once payload size is known
  header[3] = messageType;
  header[4] = encrypted ? 0x01 : 0x00; // flags: bit0 = encrypt (approximate - see file header note)
  header[5] = command || 0x00;
  // [6]=sub_command [7]=wt [8]=sb left 0
  header[9] = encrypted ? 0x01 : 0x00; // cryptor_code: aes_256_ecb=1
  header[10] = 0xee; // not_used
  header[11] = 0xee; // sequence_id
  return header;
}

function checksum(buf) {
  let sum = 0;
  for (const b of buf) sum += b;
  return sum % 256;
}
function framePanelMessage(payload) {
  return Buffer.concat([payload, Buffer.from([checksum(payload)])]);
}

function create(ctx) {
  let rxBuffer = Buffer.alloc(0);
  let sessionKey = null;
  let loggedIn = false;
  let pendingPanelLogin = false;

  function sendIpFrame(command, payload, encrypted, key) {
    const header = buildEnvelope({ messageType: MSG_TYPE.ip_request, command, encrypted, key });
    const body = encrypted ? aesEcbEncrypt(key, payload) : padTo16(payload, 0xee);
    header.writeUInt16LE(body.length, 1);
    ctx.connection.send(Buffer.concat([header, body]));
  }
  function sendPanelMessage(payload) {
    const framed = framePanelMessage(payload);
    const header = buildEnvelope({ messageType: MSG_TYPE.serial_passthrough_request, command: 0x00, encrypted: true, key: sessionKey });
    const body = aesEcbEncrypt(sessionKey, framed);
    header.writeUInt16LE(body.length, 1);
    ctx.connection.send(Buffer.concat([header, body]));
  }

  function startHandshake() {
    const modulePassword = ctx.config.settings.modulePassword || "paradox";
    const key = padKey32(modulePassword);
    sendIpFrame(IP_CMD.connect, key, true, key); // per pai: connect payload IS the key, encrypted with itself
  }

  function performAction(action, partition) {
    // Spectra/Magellan PerformAction (command 0x40) - see file header re:
    // no per-call PIN, the PC Password login already authorized the session.
    const payload = Buffer.alloc(35, 0);
    payload[0] = 0x40;
    payload[2] = action;
    payload[3] = Math.max(0, (partition || 1) - 1);
    sendPanelMessage(payload);
  }

  ctx.onAction("armAway", ({ partition = 1 }) => performAction(ACTION.Full_Arm, partition));
  ctx.onAction("armStay", ({ partition = 1 }) => performAction(ACTION.Stay_Arm, partition));
  ctx.onAction("disarm", ({ partition = 1 }) => performAction(ACTION.Disarm, partition));

  function loginToPanel() {
    // InitiateCommunication: command nibble 7, reserved nibble 2 -> 0x72
    sendPanelMessage(Buffer.from([0x72]));
    pendingPanelLogin = true;
  }
  function sendInitializeCommunication() {
    const pcPassword = (ctx.config.settings.pcPassword || "0000").padStart(4, "0");
    const passwordBytes = Buffer.from(pcPassword, "hex");
    const payload = Buffer.alloc(37, 0);
    payload[0] = 0x00; // InitializeCommunication reply to 0x72's 0x10/0x70/0x00 handshake
    passwordBytes.copy(payload, 5);
    sendPanelMessage(payload);
  }

  function handleIpFrame(header, body) {
    const command = header[5];
    const encrypted = header[9] === 0x01;
    if (command === IP_CMD.connect) {
      const modulePassword = ctx.config.settings.modulePassword || "paradox";
      const key = padKey32(modulePassword);
      const decrypted = encrypted ? aesEcbDecrypt(key, body) : body;
      // Per pai: response payload starts with a login_status byte, then a
      // fresh 16-byte session key when status===success (0x00).
      if (decrypted[0] === 0x00) {
        sessionKey = decrypted.slice(1, 17);
        ctx.log("IP150 session established");
        sendIpFrame(IP_CMD.keep_alive, Buffer.alloc(0), false, null);
        loginToPanel();
      } else {
        ctx.log(`IP150 login failed (status ${decrypted[0]})`);
        ctx.emitEvent("loginFailed", {});
      }
    } else if (command === IP_CMD.keep_alive) {
      sendIpFrame(IP_CMD.upload_download, Buffer.alloc(0), false, null);
    } else if (command === IP_CMD.upload_download) {
      sendIpFrame(IP_CMD.toggle_keep_alive, Buffer.alloc(0), false, null);
    }
  }
  function handlePanelFrame(payload) {
    if (pendingPanelLogin) {
      pendingPanelLogin = false;
      sendInitializeCommunication();
      return;
    }
    const replyCode = payload[0];
    if (replyCode === 0x10) {
      loggedIn = true;
      ctx.log("Logged into panel");
      ctx.emitEvent("connected", {});
    } else if (replyCode === 0x70 || replyCode === 0x00) {
      ctx.log("Panel login rejected (wrong PC Password?)");
      ctx.emitEvent("loginFailed", {});
    }
  }

  return {
    onConnect() {
      rxBuffer = Buffer.alloc(0);
      sessionKey = null;
      loggedIn = false;
      startHandshake();
    },
    onDisconnect() {
      loggedIn = false;
    },
    onData(chunk) {
      rxBuffer = Buffer.concat([rxBuffer, chunk]);
      while (rxBuffer.length >= 16) {
        if (rxBuffer[0] !== 0xaa) {
          rxBuffer = rxBuffer.slice(1);
          continue;
        }
        const bodyLen = rxBuffer.readUInt16LE(1);
        const totalLen = 16 + bodyLen;
        if (rxBuffer.length < totalLen) break;
        const header = rxBuffer.slice(0, 16);
        const body = rxBuffer.slice(16, totalLen);
        rxBuffer = rxBuffer.slice(totalLen);
        const messageType = header[3];
        if (messageType === MSG_TYPE.ip_response) {
          handleIpFrame(header, body);
        } else if (messageType === MSG_TYPE.serial_passthrough_response && sessionKey) {
          try {
            const decrypted = aesEcbDecrypt(sessionKey, body);
            handlePanelFrame(decrypted);
          } catch (err) {
            ctx.log(`Failed to decrypt panel frame: ${err.message}`);
          }
        }
      }
    },
  };
}

module.exports = { create };
