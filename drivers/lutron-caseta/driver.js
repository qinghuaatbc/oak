"use strict";
// Lutron Caséta driver over the Smart Bridge PRO's own local Integration
// Protocol (Lutron's own published "Integration Protocol" spec - plain
// telnet on port 23, not the newer TLS/client-cert LEAP protocol their own
// app uses). Login is a prompt/response handshake ("login:"/"password:"/
// "GNET>"), same general shape as DSC's TPI login sequence already in this
// project, just plain text instead of checksummed frames. One hub
// instance addresses many devices by their Lutron "Integration ID"
// (assigned per-device in the Lutron app, exported as an Integration
// Report - there's no discovery call over this protocol to list devices
// the way eisy/HA/Hue have), matching zone-hub's own multi-device-per-
// instance convention.
function create(ctx) {
  let rxBuffer = "";
  let loggedIn = false;
  let sawLoginPrompt = false;
  let sawPasswordPrompt = false;

  function send(line) {
    ctx.connection.send(`${line}\r\n`);
  }

  function handleLine(line) {
    if (!line) return;
    const parts = line.split(",");
    // ~OUTPUT,<id>,1,<level> - both the reply to a ?OUTPUT query and an
    // unsolicited push when a physical switch/Pico remote changes the
    // level directly (action number 1 = "zone level").
    if (parts[0] === "~OUTPUT" && parts[2] === "1") {
      const id = parts[1];
      const level = Math.round(Number(parts[3]) || 0);
      ctx.setState("light.on", level > 0, id);
      ctx.setState("light.level", level, id);
      ctx.emitEvent("stateChanged", { id, level });
    }
  }

  function handleData(chunk) {
    rxBuffer += chunk.toString("utf8");

    if (!loggedIn) {
      if (!sawLoginPrompt && rxBuffer.toLowerCase().includes("login:")) {
        sawLoginPrompt = true;
        rxBuffer = "";
        send((ctx.config.settings && ctx.config.settings.username) || "lutron");
        return;
      }
      if (sawLoginPrompt && !sawPasswordPrompt && rxBuffer.toLowerCase().includes("password:")) {
        sawPasswordPrompt = true;
        rxBuffer = "";
        send((ctx.config.settings && ctx.config.settings.password) || "integration");
        return;
      }
      if (sawPasswordPrompt && rxBuffer.includes("GNET>")) {
        loggedIn = true;
        rxBuffer = "";
        ctx.log("Logged in");
        ctx.emitEvent("connected", {});
      }
      return;
    }

    let idx;
    while ((idx = rxBuffer.indexOf("\r\n")) !== -1) {
      const line = rxBuffer.slice(0, idx).trim();
      rxBuffer = rxBuffer.slice(idx + 2);
      handleLine(line);
    }
  }

  ctx.connection.on("data", handleData);

  ctx.onAction("lightOn", ({ id }) => send(`#OUTPUT,${id},1,100`));
  ctx.onAction("lightOff", ({ id }) => send(`#OUTPUT,${id},1,0`));
  ctx.onAction("setLevel", ({ id, level = 100 }) => send(`#OUTPUT,${id},1,${Math.max(0, Math.min(100, Math.round(level)))}`));

  return {
    onConnect() {
      rxBuffer = "";
      loggedIn = false;
      sawLoginPrompt = false;
      sawPasswordPrompt = false;
      ctx.log("Connected, awaiting login prompt");
    },
    onDisconnect() {
      loggedIn = false;
    },
  };
}
module.exports = { create };
