"use strict";
// Sony Bravia professional/commercial display driver over Simple IP
// Control, TCP port 20060 - HIGH confidence: fixed 24-byte packet layout
// and worked Power On/Off examples read directly from Sony's own current
// official documentation (pro-bravia.sony.net). Chosen over Sony's
// newer REST API (also real and well-documented, JSON over HTTP with a
// PSK header) specifically for broader hardware compatibility - Simple
// IP Control works across effectively all professional Bravia display
// generations, while the REST API is only on newer/select models. No
// checksum - integrity relies on TCP.
//
// MODERATE confidence specifically on the INPT parameter's exact 8+8
// digit sub-field split (input-type-code then port-number, each
// zero-padded within the 16-byte parameter) - the general packet
// structure and POWR examples were confirmed byte-for-byte, but this
// specific sub-field boundary wasn't independently re-verified with its
// own worked example the way POWR was.
const HEADER = "*S";
const FOOTER = "\n";

function buildPacket(type, command, param) {
  return HEADER + type + command.padEnd(4).slice(0, 4) + param.padEnd(16, "0").slice(0, 16) + FOOTER;
}

function create(ctx) {
  let rxBuffer = "";

  function send(type, command, param) {
    ctx.connection.send(buildPacket(type, command, param));
  }

  ctx.onAction("powerOn", () => send("C", "POWR", "0000000000000001"));
  ctx.onAction("powerOff", () => send("C", "POWR", "0000000000000000"));
  ctx.onAction("setInput", ({ inputType, port = 1 }) => {
    send("C", "INPT", String(inputType).padStart(8, "0") + String(port).padStart(8, "0"));
  });

  function handlePacket(packet) {
    if (!packet.startsWith(HEADER) || packet.length < 23) return;
    const type = packet[2];
    const command = packet.slice(3, 7);
    const param = packet.slice(7, 23);
    if (command === "POWR" && (type === "A" || type === "N")) {
      ctx.setState("power", param.slice(-1) === "1");
    }
  }

  return {
    onConnect() {
      rxBuffer = "";
    },
    onDisconnect() {},
    onData(chunk) {
      rxBuffer += chunk.toString("ascii");
      let idx;
      while ((idx = rxBuffer.indexOf(FOOTER)) !== -1) {
        const packet = rxBuffer.slice(0, idx);
        rxBuffer = rxBuffer.slice(idx + 1);
        if (packet) handlePacket(packet);
      }
    },
  };
}

module.exports = { create };
