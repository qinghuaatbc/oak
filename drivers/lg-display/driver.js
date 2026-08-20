"use strict";
// LG commercial/signage display driver over the Set-ID RS-232C protocol
// - HIGH confidence on the packet format (no checksum at all - confirmed
// by grepping LG's own SM-series owner's manual for "checksum"/"CRC":
// zero hits, the format simply doesn't have one) and the power command
// (`ka`), read directly from that manual's RS-232C section. MODERATE
// confidence specifically on the LAN passthrough port (9761 default here)
// - well-attested across integrator forums but not confirmed in an
// official LG PDF, and LG's protocol is known to vary somewhat between
// older LCD/PDP commercial lines and newer webOS Pro:Centric signage -
// verify against this exact model's manual if the default doesn't work.
function create(ctx) {
  let rxBuffer = "";

  function setId() {
    return String(Math.max(0, Math.min(1000, Number(ctx.config.settings.setId) || 1))).padStart(2, "0");
  }
  function send(cmd1, cmd2, data) {
    ctx.connection.send(`${cmd1}${cmd2} ${setId()} ${data}\r`);
  }

  ctx.onAction("powerOn", () => send("k", "a", "01"));
  ctx.onAction("powerOff", () => send("k", "a", "00"));
  ctx.onAction("setInputRaw", ({ hexCode }) => send("x", "b", hexCode));

  function handleLine(line) {
    // Ack format: [Command2] [SetID] [OK/NG][Data] - e.g. "a 01 OK01"
    const m = line.match(/^([a-z])\s+(\d{2})\s+(OK|NG)([0-9A-Fa-f]{2})/);
    if (!m) return;
    const [, cmd2, , result, data] = m;
    if (result !== "OK") return;
    if (cmd2 === "a") ctx.setState("power", data === "01");
  }

  return {
    onConnect() {
      rxBuffer = "";
    },
    onDisconnect() {},
    onData(chunk) {
      rxBuffer += chunk.toString("ascii");
      let idx;
      while ((idx = rxBuffer.indexOf("\r")) !== -1) {
        const line = rxBuffer.slice(0, idx).trim();
        rxBuffer = rxBuffer.slice(idx + 1);
        if (line) handleLine(line);
      }
    },
  };
}

module.exports = { create };
