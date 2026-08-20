"use strict";
// Kramer matrix switcher driver over Protocol 3000 - HIGH confidence on
// transport (TCP port 5000) and the #ROUTE command/response format,
// verified across Kramer's own official Protocol 3000 Reference Guide
// plus multiple independent product manuals (VP-771, VS-88DT).
//
// Deliberately NOT implementing a power command: the guide documents
// TWO different keywords across Kramer's own product lines (`#POWER
// <0|1>` on older scaler/switcher models vs `#STANDBY <ON|OFF>` in the
// current master spec) with no universal answer for which a given
// model accepts - same reasoning as ../extron-matrix's omitted power
// command. sendRaw exposes the escape hatch for this and anything else
// model-specific, rather than guessing one and possibly sending a
// command the target model doesn't recognize.
function create(ctx) {
  let rxBuffer = "";

  function send(cmd) {
    ctx.connection.send(`#${cmd}\r`);
  }

  ctx.onAction("route", ({ layer = 1, output, input }) => {
    send(`ROUTE ${layer},${output},${input}`);
  });
  ctx.onAction("sendRaw", ({ command }) => {
    send(command);
  });

  function handleLine(line) {
    ctx.log(line);
  }

  return {
    onConnect() {
      rxBuffer = "";
      const { loginLevel, password } = ctx.config.settings;
      if (loginLevel) send(`LOGIN ${loginLevel},${password || ""}`);
    },
    onDisconnect() {},
    onData(chunk) {
      rxBuffer += chunk.toString("ascii");
      let idx;
      while ((idx = rxBuffer.indexOf("\r")) !== -1) {
        const line = rxBuffer.slice(0, idx).replace(/^\n/, "").trim();
        rxBuffer = rxBuffer.slice(idx + 1);
        if (line) handleLine(line);
      }
    },
  };
}

module.exports = { create };
