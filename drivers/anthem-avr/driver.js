"use strict";
// Anthem AVM/MRX AV processor driver - HIGH confidence on command syntax,
// sourced from Anthem's own official RS-232/IP command spreadsheets
// (MRX-x40/AVM-70-90 and MRX x10, retrieved via web archive after the
// live links 404'd - genuine Anthem-authored files, not reconstructed
// from memory). Covers the MRX x10/x20/x40 and AVM 60/70/90 series;
// older Anthem preamps (Statement, original AVM 2) use a different,
// older protocol NOT covered here.
//
// MODERATE confidence on the default port (14999) specifically - the
// spec itself doesn't hardcode a port (it's configured per-unit and
// broadcast via discovery), 14999 comes from the community anthemav
// library's practical default, not Anthem's own doc.
//
// Known device quirk (documented, not a bug in this driver): if
// "Standby IP Control" is disabled on the unit, the first power-on
// command only wakes it and does not power on - a second must follow.
// Not automated here since it depends on that unit-side setting; if
// power-on seems unreliable, check that setting first.
function create(ctx) {
  let rxBuffer = "";

  function send(cmd) {
    ctx.connection.send(cmd + ";");
  }

  ctx.onAction("powerOn", ({ zone = 1 }) => send(`Z${zone}POW1`));
  ctx.onAction("powerOff", ({ zone = 1 }) => send(`Z${zone}POW0`));
  ctx.onAction("setVolume", ({ zone = 1, db }) => send(`Z${zone}VOL${db >= 0 ? "+" : ""}${db}`));
  ctx.onAction("setInput", ({ zone = 1, input }) => send(`Z${zone}INP${input}`));

  function handleMessage(msg) {
    let m = msg.match(/^Z(\d)POW(\d)$/);
    if (m) return ctx.setState("power", m[2] === "1", m[1]);
    m = msg.match(/^Z(\d)VOL([+-]?\d+)$/);
    if (m) return ctx.setState("volume", Number(m[2]), m[1]);
    m = msg.match(/^Z(\d)INP(\d+)$/);
    if (m) return ctx.setState("input", m[2], m[1]);
  }

  return {
    onConnect() {
      rxBuffer = "";
    },
    onDisconnect() {},
    onData(chunk) {
      rxBuffer += chunk.toString("ascii");
      let idx;
      while ((idx = rxBuffer.indexOf(";")) !== -1) {
        const msg = rxBuffer.slice(0, idx).trim();
        rxBuffer = rxBuffer.slice(idx + 1);
        if (msg && !msg.startsWith("!R")) handleMessage(msg);
      }
    },
  };
}

module.exports = { create };
