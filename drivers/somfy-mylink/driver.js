"use strict";
// Somfy myLink driver over the myLink gateway's own local JSON-RPC-over-
// TCP API (port 44100), which Somfy documents for integrators (a "MyLink
// API" spec, also what the somfy-mylink-synergy Python library and Home
// Assistant's own somfy_mylink integration are built against) - RTS
// shades/blinds are one-way RF, so myLink is the only local path to them
// at all, not a choice this driver is making. Each request/response is
// one JSON object per line.
//
// CONFIDENCE NOTE: the transport (line-delimited JSON-RPC, "auth" holding
// the system id in every request) is recalled with reasonable confidence.
// The exact method name strings (myLink.status.info / myLink.move.up /
// down / stop below) are the part most worth double-checking against the
// myLink API PDF or somfy-mylink-synergy's source before trusting this -
// lower confidence there than the framing itself.
function create(ctx) {
  let rxBuffer = "";
  let requestId = 0;
  const pending = new Map();

  function call(method, params) {
    requestId += 1;
    const id = requestId;
    const payload = JSON.stringify({ id, method, params: { auth: ctx.config.settings.systemId || "", ...params } });
    ctx.connection.send(`${payload}\n`);
    return new Promise((resolve) => {
      pending.set(id, resolve);
      ctx.clock.after(5000, () => {
        if (pending.has(id)) {
          pending.delete(id);
          resolve(null);
        }
      });
    });
  }
  function command(cmd) {
    const targetId = ctx.config.settings.targetId;
    call("myLink.move", { targetID: targetId, command: cmd });
  }

  function handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result || msg);
      pending.delete(msg.id);
    }
  }

  ctx.onAction("up", () => command("up"));
  ctx.onAction("down", () => command("down"));
  ctx.onAction("stop", () => command("stop"));
  ctx.onAction("discoverTargets", async () => {
    const result = await call("myLink.status.info", {});
    if (result && result.targetIDs) {
      const targets = result.targetIDs.map((id, i) => ({ id, name: (result.targetNames || [])[i] }));
      ctx.setState("discovery.targets", JSON.stringify(targets));
    }
  });

  return {
    onConnect() {
      rxBuffer = "";
    },
    onDisconnect() {
      pending.clear();
    },
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
