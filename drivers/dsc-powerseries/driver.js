"use strict";
// DSC PowerSeries driver (Envisalink/TPI transport) for the Oak runtime.
//
// Written directly from the publicly-published DSC TPI command/checksum
// specification. The command codes for arm/disarm/keystroke below have NOT
// been verified against a real panel or the official TPI command reference
// in this session - treat them as a plausible starting point to check
// against the real spec (or a real panel's TraceViewer-equivalent log)
// before relying on them, same disclaimer as any first-draft driver.

function checksum(payload) {
  let sum = 0;
  for (let i = 0; i < payload.length; i++) sum += payload.charCodeAt(i) & 0xff;
  return (sum % 256).toString(16).toUpperCase().padStart(2, "0");
}

function frame(cmd, data) {
  const payload = cmd + (data || "");
  return payload + checksum(payload) + "\r\n";
}

function create(ctx) {
  let rxBuffer = "";
  let loggedIn = false;
  let keepalive = null;

  function send(cmd, data) {
    ctx.connection.send(frame(cmd, data));
  }

  function handleLine(line) {
    const cmd = line.slice(0, 3);
    const rest = line.slice(3, -2); // strip the trailing 2-hex checksum

    switch (cmd) {
      case "505": // login requested by the panel/Envisalink module
        send("005", ctx.config.settings.password || "user");
        break;

      case "500": // command acknowledged - first ack after login means we're in
        if (!loggedIn) {
          loggedIn = true;
          ctx.log("Logged in");
          keepalive = ctx.clock.every(10000, () => send("000"));
          ctx.emitEvent("connected", {});
        }
        break;

      case "609": // zone open
        ctx.setState("zone.open", true, rest);
        ctx.emitEvent("zoneOpen", { zone: Number(rest) });
        break;

      case "610": // zone restored
        ctx.setState("zone.open", false, rest);
        ctx.emitEvent("zoneRestore", { zone: Number(rest) });
        break;

      case "652": { // partition armed
        const partition = rest[0];
        const mode = rest.slice(1);
        ctx.setState("partition.status", "armed", partition);
        ctx.emitEvent("partitionArmed", { partition: Number(partition), mode });
        break;
      }

      case "655": { // partition disarmed
        const partition = rest[0];
        ctx.setState("partition.status", "disarmed", partition);
        ctx.emitEvent("partitionDisarmed", { partition: Number(partition) });
        break;
      }

      case "654": { // partition in alarm
        const partition = rest[0];
        ctx.setState("partition.status", "alarm", partition);
        ctx.emitEvent("alarm", { partition: Number(partition) });
        break;
      }

      default:
        // Not every TPI command is handled in this starter driver - extend
        // this switch against the real command reference as needed.
        break;
    }
  }

  ctx.onAction("armAway", ({ partition = 1 }) => send("030", String(partition)));
  ctx.onAction("armStay", ({ partition = 1 }) => send("031", String(partition)));
  ctx.onAction("disarm", ({ partition = 1, code }) =>
    send("040", String(partition) + (code || ctx.config.settings.accessCode || ""))
  );
  ctx.onAction("sendKeys", ({ partition = 1, keys }) => send("071", String(partition) + keys));

  return {
    onConnect() {
      rxBuffer = "";
      loggedIn = false;
      ctx.log("Transport connected, waiting for panel login request (505)");
    },
    onDisconnect() {
      if (keepalive) keepalive.cancel();
      loggedIn = false;
      ctx.emitEvent("disconnected", {});
    },
    onData(chunk) {
      // TPI is pure ASCII, so decoding the whole chunk as UTF-8 up front
      // is lossless here - see runtime/loader.js's Connection for why the
      // runtime hands drivers the raw Buffer instead of doing this itself.
      rxBuffer += chunk.toString("utf8");
      let idx;
      while ((idx = rxBuffer.indexOf("\r\n")) !== -1) {
        const line = rxBuffer.slice(0, idx);
        rxBuffer = rxBuffer.slice(idx + 2);
        if (line.length >= 5) handleLine(line);
      }
    },
  };
}

module.exports = { create };
