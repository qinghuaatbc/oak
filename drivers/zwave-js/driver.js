"use strict";
// Z-Wave driver over zwave-js-server (github.com/zwave-js/zwave-js-server)
// - the same WebSocket JSON-RPC-style server Home Assistant's own Z-Wave
// JS integration talks to, not a from-scratch Z-Wave stack (Z-Wave's real
// RF layer is proprietary Silicon Labs IP; zwave-js-server is the
// standard open-source way any third-party integrator reaches a Z-Wave
// network at all). One driver instance = one Z-Wave node.
//
// Manifest declares transport "http" purely so the connection form has a
// host/port to fill in - there is no REST call in this driver at all, it
// opens its own WebSocket directly (same pattern this project's eisy
// driver already uses for UDI's push event stream) since zwave-js-server
// is WS-only.
//
// Control uses zwave-js-server's generic "node.set_value" command against
// the standard Z-Wave Command Classes for a plain on/off/dimmer device -
// Binary Switch (0x25/37) and Multilevel Switch (0x26/38) are the actual
// Z-Wave Alliance-specified CC numbers for those device types, not
// invented here. Not verified against a real zwave-js-server instance
// this session - treat as a plausible starting point like any first-draft
// driver.
const RECONNECT_MS = 5000;
const CC_BINARY_SWITCH = 37;
const CC_MULTILEVEL_SWITCH = 38;

function create(ctx) {
  const host = ctx.config.connection.host;
  const port = ctx.config.connection.port || 3000;
  const nodeId = Number(ctx.config.settings.nodeId);
  const endpoint = Number(ctx.config.settings.endpoint || 0);

  let ws = null;
  let stopped = false;
  let reconnectHandle = null;
  let msgSeq = 0;

  function nextMessageId() {
    msgSeq += 1;
    return `oak-${msgSeq}`;
  }
  function sendCommand(command, extra) {
    if (!ws || ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ messageId: nextMessageId(), command, ...extra }));
  }
  function setValue(commandClass, property, value) {
    sendCommand("node.set_value", {
      nodeId,
      valueId: { commandClass, endpoint, property },
      value,
    });
  }

  function handleEvent(event) {
    if (event.source !== "node" || event.event !== "value updated" || event.nodeId !== nodeId) return;
    const args = event.args || {};
    if (args.commandClass === CC_BINARY_SWITCH && args.property === "currentValue") {
      ctx.setState("node.on", Boolean(args.newValue), String(nodeId));
    } else if (args.commandClass === CC_MULTILEVEL_SWITCH && args.property === "currentValue") {
      ctx.setState("node.level", Number(args.newValue), String(nodeId));
    }
    ctx.emitEvent("valueUpdated", {
      nodeId,
      commandClass: args.commandClass,
      property: args.property,
      value: args.newValue,
    });
  }

  function connect() {
    if (stopped) return;
    ws = new WebSocket(`ws://${host}:${port}`);
    ws.on("open", () => {
      ctx.log(`Connected to zwave-js-server at ${host}:${port}`);
      sendCommand("start_listening");
      ctx.emitEvent("connected", {});
    });
    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === "event" && msg.event) handleEvent(msg.event);
      // "version"/"result" messages need no handling for this driver's
      // fire-and-forget action model.
    });
    ws.on("close", () => {
      if (stopped) return;
      ctx.log(`Disconnected from zwave-js-server, reconnecting in ${RECONNECT_MS}ms`);
      reconnectHandle = ctx.clock.after(RECONNECT_MS, connect);
    });
    ws.on("error", (err) => ctx.log(`zwave-js-server connection error: ${err.message}`));
  }

  ctx.onAction("turnOn", () => setValue(CC_BINARY_SWITCH, "targetValue", true));
  ctx.onAction("turnOff", () => setValue(CC_BINARY_SWITCH, "targetValue", false));
  ctx.onAction("setLevel", ({ value }) => setValue(CC_MULTILEVEL_SWITCH, "targetValue", Math.max(0, Math.min(99, Math.round(value)))));
  ctx.onAction("setValue", ({ commandClass, property, value }) => {
    let v = value;
    try {
      v = JSON.parse(value);
    } catch {
      /* keep as raw string */
    }
    setValue(Number(commandClass), property, v);
  });

  return {
    onConnect() {
      stopped = false;
      connect();
    },
    onDisconnect() {
      stopped = true;
      if (reconnectHandle) reconnectHandle.cancel();
      if (ws) ws.terminate();
    },
  };
}

module.exports = { create };
