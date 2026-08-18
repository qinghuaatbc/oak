"use strict";
// Pentair IntelliCenter driver over its local JSON-over-TCP protocol
// (port 6680) - Pentair has never published this, and pool-controller
// protocols in general are notoriously under-documented compared to most
// other categories in this project. Recalled from community
// reverse-engineering (pyintellicenter) with only MODERATE confidence -
// treat this as more of a starting sketch than most drivers here, worth
// verifying message shapes against a real panel or that project's source
// before relying on it.
function create(ctx) {
  let rxBuffer = "";
  let msgId = 0;

  function send(command, extra) {
    msgId += 1;
    ctx.connection.send(JSON.stringify({ command, messageID: `oak-${msgId}`, ...extra }) + "\n");
  }

  function handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.command === "SendParamList" && msg.objectList) {
      const circuits = msg.objectList.filter((o) => o.params && o.params.OBJTYP === "CIRCUIT").map((o) => ({ id: o.objnam, name: o.params.SNAME }));
      if (circuits.length) ctx.setState("discovery.circuits", JSON.stringify(circuits));
    }
  }

  ctx.onAction("turnOn", () => send("SetParamList", { objectList: [{ objnam: ctx.config.settings.circuitId, params: { STATUS: "ON" } }] }));
  ctx.onAction("turnOff", () => send("SetParamList", { objectList: [{ objnam: ctx.config.settings.circuitId, params: { STATUS: "OFF" } }] }));
  ctx.onAction("discoverCircuits", () => send("GetParamList", { condition: "OBJTYP=CIRCUIT", objectList: [{ objnam: "ALL", keys: ["OBJTYP", "SNAME"] }] }));

  return {
    onConnect() {
      rxBuffer = "";
    },
    onDisconnect() {},
    onData(chunk) {
      rxBuffer += chunk.toString("utf8");
      let idx;
      while ((idx = rxBuffer.indexOf("\n")) !== -1) {
        const line = rxBuffer.slice(0, idx).trim();
        rxBuffer = rxBuffer.slice(idx + 1);
        if (line) handleLine(line);
      }
    },
  };
}

module.exports = { create };
