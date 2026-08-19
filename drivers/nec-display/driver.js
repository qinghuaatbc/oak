"use strict";
// NEC commercial display driver over "External Control" (NEC/Sharp's
// MDC-equivalent), TCP port 7142 - HIGH confidence: packet framing and
// the power-control opcode read directly from NEC's own official
// External Control spec PDF (v1.2/1.3, "uhd-external_control.pdf",
// retrieved via web archive after the live link 404'd). buildPacket()
// was verified against the spec's own worked Power-On example - every
// byte before the checksum matches exactly. The one discrepancy found:
// the source material's stated checksum byte (0x77) does not match a
// from-scratch recomputation of the documented algorithm ("XOR of every
// byte from Reserved through ETX inclusive") against those same bytes,
// which gives 0x73 - most likely a transcription slip reading a scanned
// PDF table, not an error in the algorithm itself (every other byte in
// the same worked example matches perfectly). Trusting the independently
// re-derived 0x73 here rather than the possibly-misread source value.
// This is the modern "UHD" display-line spec - older NEC plasma/LCD
// commercial models used a separate, simpler protocol NOT covered here.
const SOH = 0x01, STX = 0x02, ETX = 0x03, CR = 0x0d;

function buildPacket(destChar, typeChar, messageAscii) {
  const messageBytes = Buffer.from(messageAscii, "ascii");
  const lengthHex = (2 + messageBytes.length).toString(16).toUpperCase().padStart(2, "0");
  const header = Buffer.from(`0${destChar}0${typeChar}${lengthHex}`, "ascii");
  const body = Buffer.concat([header, Buffer.from([STX]), messageBytes, Buffer.from([ETX])]);
  let bcc = 0;
  for (const b of body) bcc ^= b;
  return Buffer.concat([Buffer.from([SOH]), body, Buffer.from([bcc]), Buffer.from([CR])]);
}

function create(ctx) {
  let rxBuffer = Buffer.alloc(0);

  function dest() {
    return (ctx.config.settings.monitorId || "A").charAt(0);
  }
  function send(typeChar, messageAscii) {
    ctx.connection.send(buildPacket(dest(), typeChar, messageAscii));
  }

  ctx.onAction("powerOn", () => send("A", "C203D60001"));
  ctx.onAction("powerOff", () => send("A", "C203D60004"));

  function handlePacket(messageAscii) {
    // Power status reply echoes the C203D6 opcode followed by a 4-hex-char mode value: 0001=ON 0002=Standby 0003=Suspend 0004=OFF
    if (messageAscii.startsWith("C203D6") && messageAscii.length >= 10) {
      const mode = messageAscii.slice(-4);
      ctx.setState("power", mode === "0001");
    }
  }

  return {
    onConnect() {
      rxBuffer = Buffer.alloc(0);
    },
    onDisconnect() {},
    onData(chunk) {
      rxBuffer = Buffer.concat([rxBuffer, chunk]);
      let sohIdx;
      while ((sohIdx = rxBuffer.indexOf(SOH)) !== -1) {
        const crIdx = rxBuffer.indexOf(CR, sohIdx);
        if (crIdx === -1) {
          rxBuffer = rxBuffer.slice(sohIdx);
          break;
        }
        const packet = rxBuffer.slice(sohIdx, crIdx + 1);
        rxBuffer = rxBuffer.slice(crIdx + 1);
        const stxIdx = packet.indexOf(STX);
        const etxIdx = packet.indexOf(ETX);
        if (stxIdx !== -1 && etxIdx !== -1 && etxIdx > stxIdx) {
          handlePacket(packet.slice(stxIdx + 1, etxIdx).toString("ascii"));
        }
      }
    },
  };
}

module.exports = { create };
