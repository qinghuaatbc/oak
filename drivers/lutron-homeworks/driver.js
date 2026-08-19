"use strict";
// Lutron HomeWorks QS / RadioRA 2 / QS Integration Protocol driver
// (Telnet, NOT Caséta/LEAP - a different Lutron product line and
// protocol entirely). HIGH confidence on command syntax (#OUTPUT/
// ?OUTPUT/~OUTPUT and their worked examples are read directly from
// Lutron's own current integration protocol spec, rev AH). MODERATE
// confidence on the exact login/password prompt text specifically - the
// spec confirms default credentials and a login sequence exists but the
// literal prompt bytes didn't extract cleanly from the source PDF, so
// this driver detects the prompt with a lenient case-insensitive
// substring match ("login"/"password" appearing anywhere in the
// buffered text) rather than an exact string match - the same
// tolerant approach community libraries for this protocol use.
//
// Per spec: minimum 100ms between #-commands and 1500ms between
// ?-queries - this driver relies on ~OUTPUT async feedback for state
// updates rather than polling with ?OUTPUT, so it naturally stays well
// under those limits.
function create(ctx) {
  let rxBuffer = "";
  let loggedIn = false;
  let sentUsername = false;
  let sentPassword = false;

  function send(cmd) {
    ctx.connection.send(cmd + "\r\n");
  }

  ctx.onAction("setLevel", ({ integrationId, level, fadeSeconds = 1 }) => {
    const mins = Math.floor(fadeSeconds / 60);
    const secs = Math.floor(fadeSeconds % 60);
    const fade = `${mins}:${String(secs).padStart(2, "0")}`;
    send(`#OUTPUT,${integrationId},1,${Math.max(0, Math.min(100, level))},${fade}`);
  });
  ctx.onAction("pressButton", ({ integrationId, component }) => {
    send(`#DEVICE,${integrationId},${component},3`);
  });

  function handleLine(line) {
    const m = line.match(/^~OUTPUT,(\d+),1,([\d.]+)/);
    if (m) ctx.setState("level", Number(m[2]), m[1]);
  }

  return {
    onConnect() {
      rxBuffer = "";
      loggedIn = false;
      sentUsername = false;
      sentPassword = false;
    },
    onDisconnect() {},
    onData(chunk) {
      rxBuffer += chunk.toString("ascii");
      if (!loggedIn) {
        const lower = rxBuffer.toLowerCase();
        if (!sentUsername && lower.includes("login")) {
          send(ctx.config.settings.username || "lutron");
          sentUsername = true;
          rxBuffer = "";
          return;
        }
        if (sentUsername && !sentPassword && lower.includes("password")) {
          send(ctx.config.settings.password || "integration");
          sentPassword = true;
          loggedIn = true;
          rxBuffer = "";
          return;
        }
        return;
      }
      let idx;
      while ((idx = rxBuffer.indexOf("\n")) !== -1) {
        const line = rxBuffer.slice(0, idx).replace(/\r$/, "").trim();
        rxBuffer = rxBuffer.slice(idx + 1);
        if (line) handleLine(line);
      }
    },
  };
}

module.exports = { create };
