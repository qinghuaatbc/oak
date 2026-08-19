"use strict";
// AVPro Edge matrix switcher/scaler driver (AC series - AC-MX44/88 GEN2,
// AC-MX1616-AUHD-HDBT, ConferX AC-CX family) over its ASCII RS-232/
// TCP:23 command set. HIGH confidence: command syntax read directly from
// AVPro Edge's own official user manual (AC-MX88-44-AUHD-GEN2), verified
// consistent across multiple product manuals in the same AC family. The
// newer 8K "X" series is documented as using the same transport/style
// but its exact command table wasn't independently re-verified here -
// check that model's own manual before assuming identical syntax.
function create(ctx) {
  ctx.onAction("route", ({ input, output }) => {
    ctx.connection.send(`SET OUT${output} VS IN${input}\r`);
  });
  ctx.onAction("setScalerMode", ({ output, mode }) => {
    ctx.connection.send(`SET OUT${output} VIDEO${mode}\r`);
  });

  return {
    onConnect() {},
    onDisconnect() {},
    onData() {},
  };
}

module.exports = { create };
