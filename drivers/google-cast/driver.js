"use strict";
// Google Cast (Chromecast) driver over the CASTV2 protocol - a TLS socket
// on port 8009 carrying length-prefixed CastMessage protobuf frames. The
// CastMessage schema itself (protocol_version/source_id/destination_id/
// namespace/payload_type/payload_utf8, fields 1-6) is Google's own
// published proto (part of the open-source Chromium/Cast SDK's
// cast_channel.proto) and has been stable for years - HIGH confidence on
// the framing/schema. Namespace JSON message shapes (CONNECT/PING/
// GET_STATUS/LAUNCH/SET_VOLUME) match what every open Cast client
// (pychromecast, node-castv2, etc.) sends. Uses `require("tls")` directly
// (manifest declares "http" transport only so the loader calls onConnect
// immediately with no real dependency - see ../xiaomi-miio/driver.js's
// header comment for the same pattern) since a Chromecast's cert is
// self-signed and there's no CA to verify against.
//
// Still genuinely unverified against a real Chromecast this session -
// treat as a plausible starting point, same disclaimer as any first-draft
// driver here.
const tls = require("tls");

function writeVarint(n) {
  const bytes = [];
  while (n > 0x7f) {
    bytes.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  bytes.push(n);
  return Buffer.from(bytes);
}
function readVarint(buf, offset) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) return null;
    const byte = buf[pos];
    result |= (byte & 0x7f) << shift;
    pos++;
    if (!(byte & 0x80)) break;
    shift += 7;
  }
  return { value: result >>> 0, next: pos };
}
function tag(fieldNum, wireType) {
  return Buffer.from([(fieldNum << 3) | wireType]);
}
function encodeStringField(fieldNum, str) {
  const data = Buffer.from(str, "utf8");
  return Buffer.concat([tag(fieldNum, 2), writeVarint(data.length), data]);
}
function encodeVarintField(fieldNum, value) {
  return Buffer.concat([tag(fieldNum, 0), writeVarint(value)]);
}
function encodeCastMessage({ sourceId, destinationId, namespace, payload }) {
  const body = Buffer.concat([
    encodeVarintField(1, 0), // protocol_version = CASTV2_1_0
    encodeStringField(2, sourceId),
    encodeStringField(3, destinationId),
    encodeStringField(4, namespace),
    encodeVarintField(5, 0), // payload_type = STRING
    encodeStringField(6, payload),
  ]);
  const lenPrefix = Buffer.alloc(4);
  lenPrefix.writeUInt32BE(body.length, 0);
  return Buffer.concat([lenPrefix, body]);
}
function decodeCastMessage(body) {
  const fields = {};
  let pos = 0;
  while (pos < body.length) {
    const t = readVarint(body, pos);
    if (!t) break;
    const fieldNum = t.value >>> 3;
    const wireType = t.value & 0x7;
    pos = t.next;
    if (wireType === 0) {
      const v = readVarint(body, pos);
      if (!v) break;
      fields[fieldNum] = v.value;
      pos = v.next;
    } else if (wireType === 2) {
      const l = readVarint(body, pos);
      if (!l) break;
      fields[fieldNum] = body.slice(l.next, l.next + l.value);
      pos = l.next + l.value;
    } else {
      break;
    }
  }
  return {
    sourceId: fields[2] ? fields[2].toString("utf8") : "",
    destinationId: fields[3] ? fields[3].toString("utf8") : "",
    namespace: fields[4] ? fields[4].toString("utf8") : "",
    payload: fields[6] ? fields[6].toString("utf8") : "",
  };
}

const NS_CONNECTION = "urn:x-cast:com.google.cast.tp.connection";
const NS_HEARTBEAT = "urn:x-cast:com.google.cast.tp.heartbeat";
const NS_RECEIVER = "urn:x-cast:com.google.cast.receiver";
const SOURCE_ID = "sender-oak";
const DEST_PLATFORM = "receiver-0";

function create(ctx) {
  const host = ctx.config.connection.host;
  const port = ctx.config.connection.port || 8009;

  let socket = null;
  let rxBuffer = Buffer.alloc(0);
  let heartbeatTimer = null;
  let requestId = 0;
  let currentTransportId = DEST_PLATFORM;

  function send(namespace, payloadObj, destinationId) {
    if (!socket) return;
    const msg = encodeCastMessage({
      sourceId: SOURCE_ID,
      destinationId: destinationId || currentTransportId,
      namespace,
      payload: JSON.stringify(payloadObj),
    });
    socket.write(msg);
  }
  function nextRequestId() {
    requestId += 1;
    return requestId;
  }

  function handleMessage(namespace, payloadStr) {
    let payload;
    try {
      payload = JSON.parse(payloadStr);
    } catch {
      return;
    }
    if (namespace === NS_HEARTBEAT && payload.type === "PING") {
      send(NS_HEARTBEAT, { type: "PONG" }, DEST_PLATFORM);
      return;
    }
    if (namespace === NS_RECEIVER && payload.type === "RECEIVER_STATUS") {
      const status = payload.status || {};
      if (status.volume) {
        ctx.setState("volume.level", Math.round((status.volume.level || 0) * 100));
        ctx.setState("volume.muted", Boolean(status.volume.muted));
      }
      const app = (status.applications || [])[0];
      if (app) {
        ctx.setState("app.id", app.appId);
        currentTransportId = app.transportId || currentTransportId;
      }
      ctx.emitEvent("status", { status });
      return;
    }
    ctx.emitEvent("message", { namespace, payload });
  }

  function handleData(chunk) {
    rxBuffer = Buffer.concat([rxBuffer, chunk]);
    while (rxBuffer.length >= 4) {
      const len = rxBuffer.readUInt32BE(0);
      if (rxBuffer.length < 4 + len) break;
      const body = rxBuffer.slice(4, 4 + len);
      rxBuffer = rxBuffer.slice(4 + len);
      const msg = decodeCastMessage(body);
      if (msg.namespace) handleMessage(msg.namespace, msg.payload);
    }
  }

  ctx.onAction("launchApp", ({ appId }) =>
    send(NS_RECEIVER, { type: "LAUNCH", appId: appId || ctx.config.settings.defaultAppId, requestId: nextRequestId() }, DEST_PLATFORM)
  );
  ctx.onAction("stopApp", () => send(NS_RECEIVER, { type: "STOP", requestId: nextRequestId() }, DEST_PLATFORM));
  ctx.onAction("setVolume", ({ value }) =>
    send(NS_RECEIVER, { type: "SET_VOLUME", volume: { level: Math.max(0, Math.min(100, value)) / 100 }, requestId: nextRequestId() }, DEST_PLATFORM)
  );
  ctx.onAction("mute", () => send(NS_RECEIVER, { type: "SET_VOLUME", volume: { muted: true }, requestId: nextRequestId() }, DEST_PLATFORM));
  ctx.onAction("unmute", () => send(NS_RECEIVER, { type: "SET_VOLUME", volume: { muted: false }, requestId: nextRequestId() }, DEST_PLATFORM));
  ctx.onAction("send", ({ namespace, payload }) => {
    try {
      send(namespace, JSON.parse(payload), currentTransportId);
    } catch (err) {
      ctx.log(`send: invalid JSON payload - ${err.message}`);
    }
  });

  return {
    onConnect() {
      rxBuffer = Buffer.alloc(0);
      socket = tls.connect({ host, port, rejectUnauthorized: false }, () => {
        ctx.log("CASTV2 TLS connected");
        send(NS_CONNECTION, { type: "CONNECT" }, DEST_PLATFORM);
        send(NS_RECEIVER, { type: "GET_STATUS", requestId: nextRequestId() }, DEST_PLATFORM);
        heartbeatTimer = ctx.clock.every(5000, () => send(NS_HEARTBEAT, { type: "PING" }, DEST_PLATFORM));
      });
      socket.on("data", handleData);
      socket.on("error", (err) => ctx.log(`CASTV2 connection error: ${err.message}`));
      socket.on("close", () => ctx.log("CASTV2 connection closed"));
    },
    onDisconnect() {
      if (heartbeatTimer) heartbeatTimer.cancel();
      if (socket) socket.destroy();
      socket = null;
    },
  };
}

module.exports = { create };
