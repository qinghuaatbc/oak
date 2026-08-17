"use strict";
// iRobot Roomba (wifi-connected 900/i/s/j series) driver - the robot runs
// its own local MQTT broker on port 8883 over TLS with a self-signed
// cert, publishing its full state as retained JSON on a wildcard "#"
// subscription and accepting commands on the "cmd" topic. This whole
// protocol is reverse-engineered (iRobot has never published it) but
// extremely stable and consistently documented across dorita980/
// roomba980-python and years of community use - moderate-high confidence.
//
// GETTING blid/password: this driver does NOT implement iRobot's local
// pairing procedure (hold the robot's home button until it beeps/flashes
// to enter pairing mode, then a specific TCP handshake on port 8883
// retrieves a one-time password) - that's an interactive, physical-access
// step tools like dorita980's `get-roomba-password` CLI already handle
// well. Run that once, then paste the resulting blid/password in here.
//
// Manages its own TLS socket via require("tls") + this project's own
// hand-rolled MQTT client (see ../mqtt-plug/driver.js) rather than the
// plain-TCP ctx.connection, since the runtime's Connection has no TLS
// support - same "driver owns its own socket" pattern as ../xiaomi-miio
// and ../google-cast, with self-signed-cert verification disabled
// (rejectUnauthorized: false) since the robot's cert is never CA-signed.
const tls = require("tls");

function encodeRemainingLength(len) {
  const bytes = [];
  do {
    let b = len % 128;
    len = Math.floor(len / 128);
    if (len > 0) b |= 0x80;
    bytes.push(b);
  } while (len > 0);
  return Buffer.from(bytes);
}
function encodeUtf8String(str) {
  const data = Buffer.from(str, "utf8");
  const len = Buffer.alloc(2);
  len.writeUInt16BE(data.length, 0);
  return Buffer.concat([len, data]);
}
function encodeConnect(clientId, username, password) {
  const variableHeader = Buffer.concat([
    encodeUtf8String("MQTT"),
    Buffer.from([0x04]),
    Buffer.from([0xc2]), // clean session + username + password flags
    Buffer.from([0x00, 0x3c]), // 60s keepalive
  ]);
  const payload = Buffer.concat([encodeUtf8String(clientId), encodeUtf8String(username), encodeUtf8String(password)]);
  const remaining = variableHeader.length + payload.length;
  return Buffer.concat([Buffer.from([0x10]), encodeRemainingLength(remaining), variableHeader, payload]);
}
function encodePublish(topic, message) {
  const topicBuf = encodeUtf8String(topic);
  const payload = Buffer.from(message, "utf8");
  const remaining = topicBuf.length + payload.length;
  return Buffer.concat([Buffer.from([0x30]), encodeRemainingLength(remaining), topicBuf, payload]);
}
function encodeSubscribe(packetId, topic) {
  const variableHeader = Buffer.from([(packetId >> 8) & 0xff, packetId & 0xff]);
  const payload = Buffer.concat([encodeUtf8String(topic), Buffer.from([0x00])]);
  const remaining = variableHeader.length + payload.length;
  return Buffer.concat([Buffer.from([0x82]), encodeRemainingLength(remaining), variableHeader, payload]);
}
function encodePingreq() {
  return Buffer.from([0xc0, 0x00]);
}
function decodePackets(buffer) {
  const packets = [];
  let offset = 0;
  for (;;) {
    if (buffer.length - offset < 2) break;
    const type = buffer[offset] >> 4;
    let multiplier = 1;
    let remaining = 0;
    let pos = offset + 1;
    let byte;
    let underrun = false;
    do {
      if (pos >= buffer.length) {
        underrun = true;
        break;
      }
      byte = buffer[pos];
      remaining += (byte & 0x7f) * multiplier;
      multiplier *= 128;
      pos++;
    } while (byte & 0x80);
    if (underrun || buffer.length - pos < remaining) break;
    packets.push({ type, body: buffer.subarray(pos, pos + remaining) });
    offset = pos + remaining;
  }
  return { packets, rest: buffer.subarray(offset) };
}
function decodeUtf8String(buf, offset) {
  const len = buf.readUInt16BE(offset);
  return { value: buf.toString("utf8", offset + 2, offset + 2 + len), next: offset + 2 + len };
}

function create(ctx) {
  const host = ctx.config.connection.host;
  const port = ctx.config.connection.port || 8883;
  const blid = ctx.config.settings.blid || "";
  const password = ctx.config.settings.password || "";

  let socket = null;
  let rxBuffer = Buffer.alloc(0);
  let pingTimer = null;

  function sendCommand(command) {
    if (!socket) return;
    socket.write(encodePublish("cmd", JSON.stringify({ command, time: Math.floor(Date.now() / 1000), initiator: "localApp" })));
  }

  function handlePacket(type, body) {
    if (type === 2) {
      ctx.log("Connected to Roomba's local MQTT broker");
      socket.write(encodeSubscribe(1, "#"));
      pingTimer = ctx.clock.every(30000, () => socket.write(encodePingreq()));
    } else if (type === 3) {
      const topicResult = decodeUtf8String(body, 0);
      const raw = body.subarray(topicResult.next).toString("utf8");
      let state;
      try {
        state = JSON.parse(raw);
      } catch {
        return;
      }
      const reported = state.state && state.state.reported;
      if (!reported) return;
      if (reported.cleanMissionStatus) ctx.setState("robot.cleanMissionStatus", reported.cleanMissionStatus.phase);
      if (reported.batPct !== undefined) ctx.setState("robot.batPct", reported.batPct);
      ctx.emitEvent("stateUpdate", { state: reported });
    }
  }

  ctx.onAction("start", () => sendCommand("start"));
  ctx.onAction("stop", () => sendCommand("stop"));
  ctx.onAction("pause", () => sendCommand("pause"));
  ctx.onAction("resume", () => sendCommand("resume"));
  ctx.onAction("dock", () => sendCommand("dock"));

  return {
    onConnect() {
      if (!blid || !password) {
        ctx.log("blid/password not configured - see driver notes for how to obtain them");
        return;
      }
      rxBuffer = Buffer.alloc(0);
      socket = tls.connect({ host, port, rejectUnauthorized: false }, () => {
        socket.write(encodeConnect(blid, blid, password));
      });
      socket.on("data", (chunk) => {
        rxBuffer = Buffer.concat([rxBuffer, chunk]);
        const { packets, rest } = decodePackets(rxBuffer);
        rxBuffer = rest;
        for (const pkt of packets) handlePacket(pkt.type, pkt.body);
      });
      socket.on("error", (err) => ctx.log(`TLS connection error: ${err.message}`));
      socket.on("close", () => ctx.log("Disconnected from Roomba"));
    },
    onDisconnect() {
      if (pingTimer) pingTimer.cancel();
      if (socket) socket.destroy();
      socket = null;
    },
  };
}

module.exports = { create };
