"use strict";
// Honeywell/Ademco Vista driver (Envisalink TPI transport) for the Oak
// runtime.
//
// Envisalink's Honeywell/Ademco TPI is a DIFFERENT wire protocol from its
// DSC PowerSeries TPI (see ../dsc-powerseries/driver.js) even though both
// use the same physical Envisalink module and TCP port 4025 - this is not
// a copy-paste of that driver with renamed fields. Framing, login flow,
// and command/event codes below were read directly from the actively-
// maintained pyenvisalink library (github.com/ufodone/pyenvisalink, used
// by Home Assistant's own envisalink integration) - honeywell_client.py,
// honeywell_envisalinkdefs.py, and envisalink_base_client.py - not
// guessed. Still: this has NOT been verified against a real Vista panel
// in this session, same disclaimer as any first-draft driver - treat it
// as a plausible, source-grounded starting point.
//
// Framing: "^{code},{data}$" + "\r\n" for everything EXCEPT the login
// response, which is the raw password with no framing at all, sent only
// once in reply to a literal "Login:" prompt line.
//
// Deliberately scoped to the well-documented, simple part of this
// protocol: arm/disarm/alarm state comes from %03 (Realtime CID Event),
// a compact fixed-width numeric message. The %00 "Virtual Keypad Update"
// message (bitfield-encoded partition status + a beep/alpha-display
// field) is real-time-richer but needs a 16-bit icon/LED bitfield decode
// pyenvisalink itself only got right through real panel testing - rather
// than guess at that bit layout, %00 is logged but not parsed here. This
// mirrors this project's existing "don't guess when a role/format is
// genuinely ambiguous" call (see server.js's roleActionsForCategory
// comment for climate/sensor).
const CMD = { keepAlive: "00", changeDefaultPartition: "01", dumpZoneTimers: "02", keypress: "03" };
const ARM_DISARM_CIDS = new Set([401, 403, 407, 408, 409, 441, 442]);
// A representative subset of evl_CID_Events, not the full ~150-entry
// Ademco Contact ID table - covers the categories worth a distinct event
// name; anything else still surfaces as a generic "cidEvent" with its raw
// numeric code rather than being silently dropped.
const CID_LABELS = {
  110: "Fire Alarm", 111: "Smoke Alarm", 120: "Panic Alarm", 130: "Burglary in Progress",
  137: "Tamper Alarm", 151: "Gas Detected", 154: "Water Leak", 162: "Carbon Monoxide Detected",
  301: "AC Power Trouble", 302: "Low Battery", 401: "Armed Away", 403: "Scheduled Arming",
  406: "Cancel by User", 407: "Remote Arm/Disarm", 408: "Quick Armed Away", 409: "Armed Away (Keyswitch)",
  441: "Armed Stay", 442: "Armed Stay (Keyswitch)", 422: "Access Granted", 421: "Access Denied",
};

function create(ctx) {
  let rxBuffer = "";
  let loggedIn = false;
  let keepalive = null;

  function send(code, data) {
    ctx.connection.send(`^${code},${data || ""}$\r\n`);
  }
  // Ademco keypad keys, sent one character at a time (matches
  // pyenvisalink's queue_keypresses_to_partition - each character is its
  // own "03" PartitionKeypress command, in order) rather than as one
  // multi-char payload, which the real protocol does not accept.
  function sendKeypresses(partition, keys) {
    for (const ch of String(keys)) send(CMD.keypress, `${partition},${ch}`);
  }
  function armWith(partition, code, modeDigit) {
    sendKeypresses(partition, (code || ctx.config.settings.accessCode || "") + modeDigit);
  }

  function handleCidEvent(data) {
    const qualifier = Number(data[0]);
    const cidCode = Number(data.slice(1, 4));
    const partition = Number(data.slice(4, 6));
    const zoneOrUser = Number(data.slice(6, 9));
    if (ARM_DISARM_CIDS.has(cidCode)) {
      if (qualifier === 1) {
        ctx.setState("partition.status", "disarmed", String(partition));
        ctx.emitEvent("partitionChange", { partition, status: "disarmed" });
      } else if (qualifier === 3) {
        ctx.setState("partition.status", "armed", String(partition));
        ctx.emitEvent("partitionChange", { partition, status: "armed" });
      }
      return;
    }
    const label = CID_LABELS[cidCode] || `CID ${cidCode}`;
    if (qualifier === 1) {
      ctx.setState("zone.open", true, String(zoneOrUser));
      ctx.emitEvent("alarm", { partition });
      ctx.log(`Alarm event: ${label} (partition ${partition}, zone/user ${zoneOrUser})`);
    } else if (qualifier === 3) {
      ctx.setState("zone.open", false, String(zoneOrUser));
      ctx.emitEvent("zoneChange", { zone: zoneOrUser, open: false });
    }
  }

  function handleLine(line) {
    if (!loggedIn) {
      // Login handshake happens outside the ^/% framing entirely - the
      // panel/Envisalink sends bare "Login:", we reply with the raw
      // password, it replies "OK" or "FAILED"/"Timed Out!".
      if (line === "Login:") {
        ctx.connection.send(`${ctx.config.settings.password || "user"}\r\n`);
        return;
      }
      if (line === "OK") {
        loggedIn = true;
        ctx.log("Logged in");
        keepalive = ctx.clock.every(10000, () => send(CMD.keepAlive, ""));
        ctx.emitEvent("connected", {});
        return;
      }
      if (line === "FAILED" || line === "Timed Out!") {
        ctx.log(`TPI login failed: ${line}`);
        ctx.emitEvent("loginFailed", {});
        return;
      }
      return; // not yet logged in and not a recognized login-phase line - ignore
    }

    const match = /^([%^].+)\$$/.exec(line);
    if (!match) return;
    const parts = match[1].split(",");
    const code = parts[0];
    const data = parts.slice(1).join(",");

    switch (code) {
      case "%03": // Realtime CID Event - see handleCidEvent's own comment for why this
        // (not %00/%01/%02) is this driver's primary state source.
        handleCidEvent(data);
        break;
      case "%00": // Virtual Keypad Update - bitfield-encoded, not parsed (see file header)
      case "%01": // Zone State Change - genuinely a no-op in pyenvisalink's own Honeywell
      case "%02": // Partition State Change - client too; real state comes from %00/%03
      case "%20": // Debug message from the Envisalink itself
      case "%FF": // Raw zone timer dump
        break;
      case "^0C":
        ctx.log("Envisalink reported an invalid command");
        break;
      default:
        break;
    }
  }

  ctx.onAction("armAway", ({ partition = 1, code }) => armWith(partition, code, "2"));
  ctx.onAction("armStay", ({ partition = 1, code }) => armWith(partition, code, "3"));
  ctx.onAction("armInstant", ({ partition = 1, code }) => armWith(partition, code, "4"));
  ctx.onAction("disarm", ({ partition = 1, code }) => armWith(partition, code, "1"));
  ctx.onAction("sendKeys", ({ partition = 1, keys }) => sendKeypresses(partition, keys));

  return {
    onConnect() {
      rxBuffer = "";
      loggedIn = false;
      ctx.log("Transport connected, waiting for Login: prompt");
    },
    onDisconnect() {
      if (keepalive) keepalive.cancel();
      loggedIn = false;
      ctx.emitEvent("disconnected", {});
    },
    onData(chunk) {
      rxBuffer += chunk.toString("utf8");
      let idx;
      while ((idx = rxBuffer.indexOf("\r\n")) !== -1) {
        const line = rxBuffer.slice(0, idx);
        rxBuffer = rxBuffer.slice(idx + 2);
        if (line.length) handleLine(line);
      }
    },
  };
}

module.exports = { create };
