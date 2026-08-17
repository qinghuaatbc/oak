"use strict";
// Denon/Marantz AVR driver over their own published Telnet/TCP control
// protocol (Denon publishes an "AVR ... Control Protocol" PDF for
// custom integrators - shared, actively maintained across both Denon and
// Marantz since they're the same parent company's product lines). Plain
// ASCII commands terminated with \r (not \r\n) on port 23 - e.g. "PWON\r"
// powers on, the receiver echoes status lines back in the same format.
//
// Volume is sent as Denon's own 2-digit scale (00-98, roughly -80dB to
// +18dB with 80 as the "reference/unity" point) - this driver maps a
// plain 0-100 percentage linearly onto 0-98 rather than reproducing the
// exact dB curve, a deliberate simplification (still correctly moves
// volume up/down and reaches min/max) rather than modeling Denon's dB
// scale precisely.
function create(ctx) {
  let rxBuffer = "";

  function send(cmd) {
    ctx.connection.send(`${cmd}\r`);
  }

  function handleLine(line) {
    if (line === "PWON") ctx.setState("power.on", true);
    else if (line === "PWSTANDBY") ctx.setState("power.on", false);
    else if (line === "MUON") ctx.setState("power.muted", true);
    else if (line === "MUOFF") ctx.setState("power.muted", false);
    else if (/^MV\d{2,3}$/.test(line) && !line.startsWith("MVMAX")) {
      ctx.setState("power.volume", Math.round((Number(line.slice(2)) / 98) * 100));
    } else if (/^SI/.test(line)) {
      ctx.setState("power.input", line.slice(2));
    }
  }

  ctx.onAction("turnOn", () => send("PWON"));
  ctx.onAction("turnOff", () => send("PWSTANDBY"));
  ctx.onAction("setVolume", ({ value }) => send(`MV${String(Math.round((Math.max(0, Math.min(100, value)) / 100) * 98)).padStart(2, "0")}`));
  ctx.onAction("mute", () => send("MUON"));
  ctx.onAction("unmute", () => send("MUOFF"));
  ctx.onAction("setInput", ({ input }) => send(`SI${String(input).toUpperCase()}`));

  return {
    onConnect() {
      rxBuffer = "";
      // Ask the receiver to report its current state on connect - Denon
      // status queries are the command name with "?" instead of a value.
      send("PW?");
      send("MV?");
      send("MU?");
      send("SI?");
    },
    onDisconnect() {},
    onData(chunk) {
      rxBuffer += chunk.toString("ascii");
      let idx;
      while ((idx = rxBuffer.indexOf("\r")) !== -1) {
        const line = rxBuffer.slice(0, idx);
        rxBuffer = rxBuffer.slice(idx + 1);
        if (line.length) handleLine(line);
      }
    },
  };
}

module.exports = { create };
