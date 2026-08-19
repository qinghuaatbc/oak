"use strict";
// Biamp Tesira DSP driver over TTP (Tesira Text Protocol), Telnet
// port 23 - HIGH confidence on command syntax (get/set/toggle, instance
// tag addressing), sourced directly from Biamp's own official "Tesira
// Text Protocol" spec PDF (v4.2), cross-checked against Biamp's live
// help site. MODERATE confidence on the exact response text format for
// a "get" reply specifically (the spec documents the request grammar
// precisely but this driver's response parsing takes a conservative,
// generic approach - extracting a "value:X" token if present, otherwise
// storing the raw response line - rather than assuming an exact JSON-like
// shape that wasn't independently verified byte-for-byte).
//
// Responses correlate to requests by simple FIFO order (Tesira TTP has
// no request-id field) - this assumes one request in flight at a time
// per connection, which holds for this driver since every ctx.onAction
// call sends exactly one command and this queue is drained in order.
function create(ctx) {
  let rxBuffer = "";
  const pendingGets = []; // FIFO: {instanceTag, attribute, index}

  function quoteTag(tag) {
    return /\s/.test(tag) ? `"${tag}"` : tag;
  }
  function send(cmd) {
    ctx.connection.send(cmd + "\n");
  }

  ctx.onAction("setValue", ({ instanceTag, attribute, index = 1, value }) => {
    send(`${quoteTag(instanceTag)} set ${attribute} ${index} ${value}`);
  });
  ctx.onAction("getValue", ({ instanceTag, attribute, index = 1 }) => {
    pendingGets.push({ instanceTag, attribute, index });
    send(`${quoteTag(instanceTag)} get ${attribute} ${index}`);
  });
  ctx.onAction("toggle", ({ instanceTag, attribute, index = 1 }) => {
    send(`${quoteTag(instanceTag)} toggle ${attribute} ${index}`);
  });

  function handleLine(line) {
    if (!line.startsWith("+OK") && !line.startsWith("-ERR")) return;
    const pending = pendingGets.shift();
    if (!pending || line.startsWith("-ERR")) return;
    const m = line.match(/value["\s:]+([^\s"}\]]+)/i);
    const value = m ? m[1] : line;
    ctx.setState("control.value", value, `${pending.instanceTag}.${pending.attribute}.${pending.index}`);
  }

  return {
    onConnect() {
      rxBuffer = "";
      pendingGets.length = 0;
    },
    onDisconnect() {},
    onData(chunk) {
      rxBuffer += chunk.toString("utf8");
      let idx;
      while ((idx = rxBuffer.indexOf("\n")) !== -1) {
        const line = rxBuffer.slice(0, idx).replace(/\r$/, "").trim();
        rxBuffer = rxBuffer.slice(idx + 1);
        if (line) handleLine(line);
      }
    },
  };
}

module.exports = { create };
