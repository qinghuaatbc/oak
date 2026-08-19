"use strict";
// Samsung commercial display driver over MDC (Multiple Display Control) -
// HIGH confidence on framing/checksum: read directly from Samsung's own
// MDC protocol spec (v15.0), including its worked Power-On example
// (AA 11 FE 01 01 11), which confirms the checksum is a plain sum of
// every byte after the 0xAA header, truncated to its low byte (mod 0x100).
//
// LOWER CONFIDENCE on input-source codes specifically: the numeric codes
// for HDMI1/HDMI2/etc are NOT universal across Samsung display
// generations (confirmed by research against the command table) - rather
// than hardcode a guess that could select the wrong input on a given
// model, setInputRaw takes the raw hex code directly so the installer
// can look it up in their specific display's MDC command table.
const CMD_POWER = 0x11;
const CMD_INPUT = 0x14;

function checksum(bytes) {
  let sum = 0;
  for (const b of bytes) sum += b;
  return sum & 0xff;
}
function buildPacket(id, cmd, data) {
  const body = [cmd, id, data.length, ...data];
  return Buffer.from([0xaa, ...body, checksum(body)]);
}

function create(ctx) {
  let rxBuffer = Buffer.alloc(0);

  function send(cmd, data) {
    const id = Number(ctx.config.settings.displayId);
    ctx.connection.send(buildPacket(isNaN(id) ? 0xfe : id, cmd, data));
  }

  ctx.onAction("powerOn", () => send(CMD_POWER, [0x01]));
  ctx.onAction("powerOff", () => send(CMD_POWER, [0x00]));
  ctx.onAction("setInputRaw", ({ hexCode }) => {
    const value = parseInt(hexCode, 16);
    if (!isNaN(value)) send(CMD_INPUT, [value & 0xff]);
  });

  function handlePacket(buf) {
    // ACK/NAK response: [0xAA][0xFF][ID][len][0x41=ACK|0x4E=NAK][echoed cmd][...][checksum]
    if (buf[1] !== 0xff) return;
    const ackNak = buf[4];
    const echoedCmd = buf[5];
    if (ackNak !== 0x41) return; // NAK or malformed - nothing to update state from
    if (echoedCmd === CMD_POWER && buf.length >= 7) ctx.setState("power", buf[6] === 0x01);
  }

  return {
    onConnect() {
      rxBuffer = Buffer.alloc(0);
    },
    onDisconnect() {},
    onData(chunk) {
      rxBuffer = Buffer.concat([rxBuffer, chunk]);
      while (rxBuffer.length >= 5) {
        if (rxBuffer[0] !== 0xaa) {
          rxBuffer = rxBuffer.slice(1);
          continue;
        }
        const dataLen = rxBuffer[3];
        const totalLen = 4 + dataLen + 1; // header(4: AA,cmd,id,len) + data + checksum
        if (rxBuffer.length < totalLen) break;
        const packet = rxBuffer.slice(0, totalLen);
        rxBuffer = rxBuffer.slice(totalLen);
        handlePacket(packet);
      }
    },
  };
}

module.exports = { create };
