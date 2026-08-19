"use strict";
// Projector driver over PJLink, the open cross-vendor projector control
// standard (JBMIA) - covers Epson/Sony/JVC/BenQ/Panasonic/NEC/etc in one
// driver rather than one per brand. HIGH confidence: command bytes, the
// MD5 auth handshake, and response formats below are read directly from
// the official PJLink Class 1 specification v1.04 (including its own
// worked auth example), not reconstructed from memory.
const crypto = require("crypto");

function create(ctx) {
  let rxBuffer = "";
  let authPrefix = ""; // MD5(seed+password), prepended to exactly the first command sent after the challenge - see connect handling below
  let awaitingGreeting = true;

  function send(cmd) {
    const line = authPrefix + cmd;
    authPrefix = ""; // only the first command after the auth challenge carries the digest
    ctx.connection.send(line);
  }

  function handleGreeting(line) {
    awaitingGreeting = false;
    if (line === "PJLINK 0") return; // security disabled, nothing to do
    const m = line.match(/^PJLINK 1 ([0-9a-fA-F]{8})$/);
    if (m) {
      const seed = m[1];
      const password = ctx.config.settings.password || "";
      authPrefix = crypto.createHash("md5").update(seed + password).digest("hex");
      return;
    }
    if (line === "PJLINK ERRA") {
      ctx.log("PJLink authorization failed - check the configured password");
    }
  }

  function handleResponse(line) {
    // %1<CMD>=<value>
    const m = line.match(/^%1([A-Z]{4})=(.*)$/);
    if (!m) return;
    const [, cmd, value] = m;
    if (value.startsWith("ERR")) {
      ctx.log(`${cmd} error: ${value}`);
      return;
    }
    if (cmd === "POWR") ctx.setState("power", value === "1" || value === "2");
    else if (cmd === "INPT") ctx.setState("input", value);
    else if (cmd === "ERST") ctx.setState("errorStatus", value);
    else if (cmd === "LAMP") ctx.setState("lampHours", value.split(" ")[0]);
  }

  function refresh() {
    send("%1POWR ?\r");
    send("%1INPT ?\r");
    send("%1ERST ?\r");
    send("%1LAMP ?\r");
  }

  ctx.onAction("powerOn", () => send("%1POWR 1\r"));
  ctx.onAction("powerOff", () => send("%1POWR 0\r"));
  ctx.onAction("setInput", ({ source, number }) => send(`%1INPT ${source}${number}\r`));
  ctx.onAction("mute", ({ target = "3", state = "1" }) => send(`%1AVMT ${target}${state}\r`));

  let pollTimer = null;

  return {
    onConnect() {
      rxBuffer = "";
      authPrefix = "";
      awaitingGreeting = true;
      pollTimer = ctx.clock.every(30000, refresh);
    },
    onDisconnect() {
      if (pollTimer) pollTimer.cancel();
    },
    onData(chunk) {
      rxBuffer += chunk.toString("ascii");
      let idx;
      while ((idx = rxBuffer.indexOf("\r")) !== -1) {
        const line = rxBuffer.slice(0, idx).trim();
        rxBuffer = rxBuffer.slice(idx + 1);
        if (!line) continue;
        if (awaitingGreeting && line.startsWith("PJLINK")) {
          handleGreeting(line);
          refresh();
        } else if (line.startsWith("%1")) {
          handleResponse(line);
        }
      }
    },
  };
}

module.exports = { create };
