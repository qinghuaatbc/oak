"use strict";
// Furman/Panamax rack power sequencer driver - MODERATE confidence, and
// narrower than most drivers in this project: the ASCII command set
// below is real and documented, but specifically for Furman's
// Contractor Series CN-1800S/CN-2400S sequencer family. It does NOT
// necessarily generalize to other Furman/Panamax rack power products -
// many simpler power-conditioner models are passive with no RS232/IP
// control at all. Before using this driver, confirm the target unit is
// actually a CN-1800S/CN-2400S (or a close sibling using the same
// command set), not just any Furman/Panamax product.
function create(ctx) {
  function seq() {
    return Number(ctx.config.settings.sequencer) || 1;
  }
  function send(cmd) {
    ctx.connection.send(cmd + "\r");
  }

  ctx.onAction("sequencerOn", () => send("!SEQ_ON"));
  ctx.onAction("sequencerOff", () => send("!SEQ_OFF"));
  ctx.onAction("bankOn", ({ outlet }) => send(`!BANK_ON ${seq()} ${outlet}`));
  ctx.onAction("bankOff", ({ outlet }) => send(`!BANK_OFF ${seq()} ${outlet}`));
  ctx.onAction("allOff", () => send(`!ALL_OFF ${seq()}`));

  return {
    onConnect() {},
    onDisconnect() {},
    onData() {},
  };
}

module.exports = { create };
