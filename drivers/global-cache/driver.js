"use strict";
// Global Caché (iTach/GC-100) driver over their own published local TCP
// API (Global Caché documents this themselves as the "iTach API" for
// integrators - this is one of the most established IR/RF/serial-over-IP
// control protocols in the custom-install industry, alongside brands like
// RTI/Crestron, but with an actually-published spec) - real, official,
// high confidence. Plain ASCII commands terminated with \r on port 4998.
function create(ctx) {
  let rxBuffer = "";
  let irId = 0; // per-instance, not module-scoped - each Global Caché instance correlates its own sendir/completeir replies independently

  function send(cmd) {
    ctx.connection.send(`${cmd}\r`);
  }

  function handleLine(line) {
    if (line.startsWith("state,")) {
      const parts = line.split(",");
      const state = parts[2];
      if (state !== undefined) ctx.setState("connector.state", state.trim() === "1");
    } else if (line.startsWith("device,")) {
      ctx.log(`Device: ${line}`);
    } else if (line.startsWith("ERR")) {
      ctx.log(`Global Caché error: ${line}`);
    }
  }

  ctx.onAction("sendIr", ({ irCode }) => {
    irId += 1;
    const { module: mod, connector } = ctx.config.settings;
    send(`sendir,${mod || 1}:${connector || 1},${irId},${irCode}`);
  });
  ctx.onAction("setStateOn", () => {
    const { module: mod, connector } = ctx.config.settings;
    send(`setstate,${mod || 1}:${connector || 1},1`);
  });
  ctx.onAction("setStateOff", () => {
    const { module: mod, connector } = ctx.config.settings;
    send(`setstate,${mod || 1}:${connector || 1},0`);
  });
  ctx.onAction("discoverDevices", () => send("getdevices"));

  return {
    onConnect() {
      rxBuffer = "";
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
