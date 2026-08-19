"use strict";
// QSC Q-SYS Core driver over QRC (JSON-RPC 2.0 over TCP, port 1710,
// each message null-terminated) - HIGH confidence: method names/shapes
// read directly from QSC's own QRC documentation. Auth is conditional -
// a Core with no users configured skips Logon entirely; this driver
// only sends Logon when username/password are configured.
function create(ctx) {
  let rxBuffer = "";
  let msgId = 0;
  const pendingGets = new Map(); // id -> control name, so a Control.Get response can be routed back to the right state key

  function sendRpc(method, params) {
    const id = ++msgId;
    const msg = { jsonrpc: "2.0", id, method, params };
    ctx.connection.send(JSON.stringify(msg) + "\0");
    return id;
  }

  ctx.onAction("setControl", ({ name, value }) => {
    sendRpc("Control.Set", { Name: name, Value: value });
  });
  ctx.onAction("getControl", ({ name }) => {
    const id = sendRpc("Control.Get", [name]);
    pendingGets.set(id, name);
  });

  function handleMessage(msg) {
    if (msg.method === "EngineStatus") {
      ctx.setState("core.state", msg.params && msg.params.State);
      return;
    }
    if (msg.id !== undefined && pendingGets.has(msg.id)) {
      const name = pendingGets.get(msg.id);
      pendingGets.delete(msg.id);
      const result = msg.result && msg.result[0];
      if (result) ctx.setState("control.value", result.Value, name);
    }
  }

  let keepaliveTimer = null;

  return {
    onConnect() {
      rxBuffer = "";
      const { username, password } = ctx.config.settings;
      if (username) sendRpc("Logon", { User: username, Password: password || "" });
      // The Core drops the socket if nothing is received for ~60s - NoOp
      // is QSC's documented keepalive method for exactly this purpose.
      keepaliveTimer = ctx.clock.every(45000, () => sendRpc("NoOp", {}));
    },
    onDisconnect() {
      if (keepaliveTimer) keepaliveTimer.cancel();
      pendingGets.clear();
    },
    onData(chunk) {
      rxBuffer += chunk.toString("utf8");
      let idx;
      while ((idx = rxBuffer.indexOf("\0")) !== -1) {
        const raw = rxBuffer.slice(0, idx);
        rxBuffer = rxBuffer.slice(idx + 1);
        if (!raw.trim()) continue;
        try {
          handleMessage(JSON.parse(raw));
        } catch (err) {
          ctx.log(`Failed to parse message: ${err.message}`);
        }
      }
    },
  };
}

module.exports = { create };
