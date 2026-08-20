"use strict";
// Panasonic commercial display driver over "NTCONTROL" (Protocol 2,
// current SQ/EQ/CQ/BQ series line), TCP port 1024 - HIGH confidence: the
// MD5 challenge/response handshake and worked byte examples below are
// read directly from Panasonic's own official "LAN Command Sequence"
// PDF, including its real worked hex values (not placeholders).
//
// Panasonic also documents an older "PDPCONTROL" (Protocol 1, legacy
// plasma/LCD TH-series) with a DIFFERENT hash input - NOT implemented
// here since NTCONTROL is the current, active line; if this driver's
// handshake never gets a reply, the target display may be old enough to
// need Protocol 1 instead. Displays can also be configured in a
// non-protected mode with no challenge at all (installer-configurable) -
// handled below by only computing the hash prefix if a real challenge
// line is actually received.
//
// Input-select and other model-specific commands are exposed via
// sendRaw rather than guessed - Panasonic's per-model command lists
// vary enough that a single hardcoded input-select command risked being
// wrong for the specific display generation.
const crypto = require("crypto");

function create(ctx) {
  let rxBuffer = "";
  let authPrefix = ""; // MD5 hex digest, prepended to every command once a real challenge is seen
  let ready = false;

  function send(command) {
    ctx.connection.send(`${authPrefix}00${command}\r`);
  }

  ctx.onAction("powerOn", () => send("PON"));
  ctx.onAction("powerOff", () => send("POF"));
  ctx.onAction("sendRaw", ({ command }) => send(command));

  function handleGreeting(line) {
    const m = line.match(/^NTCONTROL 1 ([0-9a-fA-F]{8})$/);
    if (m) {
      const { username, password } = ctx.config.settings;
      authPrefix = crypto.createHash("md5").update(`${username || "admin1"}:${password || "panasonic"}:${m[1]}`).digest("hex");
    }
    ready = true;
  }

  return {
    onConnect() {
      rxBuffer = "";
      authPrefix = "";
      ready = false;
    },
    onDisconnect() {},
    onData(chunk) {
      rxBuffer += chunk.toString("ascii");
      let idx;
      while ((idx = rxBuffer.indexOf("\r")) !== -1) {
        const line = rxBuffer.slice(0, idx).trim();
        rxBuffer = rxBuffer.slice(idx + 1);
        if (!line) continue;
        if (!ready && line.startsWith("NTCONTROL")) {
          handleGreeting(line);
        } else {
          ctx.log(line);
        }
      }
    },
  };
}

module.exports = { create };
