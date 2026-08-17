"use strict";
// Logitech Harmony Hub driver - Logitech discontinued Harmony but the
// hub's local API (a websocket on port 8088 carrying JSON-wrapped
// "vnd.logitech.harmony" command URIs) still works and remains well
// documented by community projects (pyharmony, harmony-api) that kept it
// alive after Logitech stopped actively maintaining it themselves.
//
// CONFIDENCE NOTE: this is one of the lower-confidence drivers in this
// project - the general shape (JSON commands wrapped in an "hbus" object
// naming a "vnd.logitech.harmony.engine?<verb>" URI) is recalled
// correctly, but exact field names for less common commands may not
// match the current hub firmware exactly. Treat this as a starting
// point to verify against a real hub (or pyharmony's source) more than
// most drivers here.
function create(ctx) {
  const host = ctx.config.connection.host;
  let ws = null;
  let msgId = 0;

  function send(uri, params) {
    if (!ws || ws.readyState !== ws.OPEN) return;
    msgId += 1;
    const id = `oak.${msgId}`;
    ws.send(JSON.stringify({ hubId: "oak", timeout: 30, hbus: { cmd: uri, id, params: params || {} } }));
    return id;
  }

  ctx.onAction("startActivity", ({ activityId }) =>
    send("vnd.logitech.harmony/vnd.logitech.harmony.engine?startactivity", { activityId, timestamp: 0 })
  );
  ctx.onAction("turnOff", () => send("vnd.logitech.harmony/vnd.logitech.harmony.engine?startactivity", { activityId: "-1", timestamp: 0 }));
  ctx.onAction("pressButton", ({ deviceId, command }) => {
    const action = JSON.stringify({ command, type: "IRCommand", deviceId });
    send("vnd.logitech.harmony/vnd.logitech.harmony.engine?holdAction", { status: "press", timestamp: Date.now(), verb: "render", action });
    ctx.clock.after(200, () => send("vnd.logitech.harmony/vnd.logitech.harmony.engine?holdAction", { status: "release", timestamp: Date.now(), verb: "render", action }));
  });
  ctx.onAction("discoverConfig", () => send("vnd.logitech.harmony/vnd.logitech.harmony.engine?config", { verb: "get", format: "json" }));

  return {
    onConnect() {
      ws = new WebSocket(`ws://${host}:8088/`);
      ws.on("message", (data) => {
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (msg.data) ctx.setState("discovery.config", JSON.stringify(msg.data));
      });
      ws.on("error", (err) => ctx.log(`Connection error: ${err.message}`));
    },
    onDisconnect() {
      if (ws) ws.terminate();
      ws = null;
    },
  };
}

module.exports = { create };
