"use strict";
// Extron matrix switcher driver over SIS (Simple Instruction Set), the
// ASCII Telnet protocol shared across Extron's CrossPoint/DTP CrossPoint/
// Matrix product lines. MODERATE confidence: the tie (switch) and mute
// command syntax below is corroborated across multiple independent
// manual excerpts (CrossPoint 300, DTP CrossPoint, Matrix 12800) and
// safe to trust. Deliberately NOT implementing a power on/off action -
// research could not confirm a single SIS power command consistent
// across the matrix switcher line (some models have no power command at
// all, being always-on; others vary by product family) - guessing one
// risked sending a real command the target model interprets differently.
// If the specific model has a power command, check its own SIS table and
// add it as a follow-up rather than assuming this driver's omission is a
// bug.
function create(ctx) {
  ctx.onAction("tie", ({ input, output }) => {
    ctx.connection.send(`${input}*${output}!\r\n`);
  });
  ctx.onAction("mute", ({ output, state = "1" }) => {
    ctx.connection.send(`${output}*${state}B\r\n`);
  });

  return {
    onConnect() {},
    onDisconnect() {},
    onData() {},
  };
}

module.exports = { create };
