"use strict";
// Frigate NVR driver over its own published MQTT integration
// (docs.frigate.video/integrations/mqtt) - a real, documented API, high
// confidence. Speaks plain MQTT v3.1.1 over the runtime's TCP Connection
// (QoS 0 only), reusing this project's own hand-rolled MQTT client (see
// ../mqtt-plug/driver.js) rather than a new protocol implementation.
// Subscribes to Frigate's per-camera per-object detection state topic
// (retained "ON"/"OFF") and the global events topic (JSON on every new
// tracked-object event); publishes to the documented .../set topics to
// toggle detection/recording/snapshots per camera.
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
function encodeConnect(clientId, keepAliveSec) {
  const variableHeader = Buffer.concat([
    encodeUtf8String("MQTT"),
    Buffer.from([0x04]),
    Buffer.from([0x02]),
    Buffer.from([(keepAliveSec >> 8) & 0xff, keepAliveSec & 0xff]),
  ]);
  const payload = encodeUtf8String(clientId);
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
  const baseTopic = ctx.config.settings.baseTopic || "frigate";
  const cameraName = ctx.config.settings.cameraName || "";
  const objectLabel = ctx.config.settings.objectLabel || "person";
  const clientId = ctx.config.settings.clientId || "oak-frigate";
  const objectTopic = `${baseTopic}/${cameraName}/${objectLabel}`;
  const eventsTopic = `${baseTopic}/events`;

  let rxBuffer = Buffer.alloc(0);
  let pingTimer = null;

  function publishSet(suffix, on) {
    ctx.connection.send(encodePublish(`${baseTopic}/${cameraName}/${suffix}/set`, on ? "ON" : "OFF"));
  }

  function handlePacket(type, body) {
    if (type === 2) {
      ctx.log("MQTT connected, subscribing to Frigate topics");
      ctx.connection.send(encodeSubscribe(1, objectTopic));
      ctx.connection.send(encodeSubscribe(2, eventsTopic));
      pingTimer = ctx.clock.every(20000, () => ctx.connection.send(encodePingreq()));
    } else if (type === 3) {
      const topicResult = decodeUtf8String(body, 0);
      const raw = body.subarray(topicResult.next).toString("utf8");
      if (topicResult.value === objectTopic) {
        const on = raw.trim().toUpperCase() === "ON";
        ctx.setState("detection.active", on);
        ctx.emitEvent("objectDetected", { label: objectLabel, on });
      } else if (topicResult.value === eventsTopic) {
        try {
          ctx.emitEvent("newEvent", { payload: JSON.parse(raw) });
        } catch {
          /* non-JSON payload - ignore */
        }
      }
    }
  }

  ctx.onAction("setDetect", ({ on }) => publishSet("detect", on));
  ctx.onAction("setRecordings", ({ on }) => publishSet("recordings", on));
  ctx.onAction("setSnapshots", ({ on }) => publishSet("snapshots", on));

  return {
    onConnect() {
      rxBuffer = Buffer.alloc(0);
      ctx.connection.send(encodeConnect(clientId, 60));
    },
    onDisconnect() {
      if (pingTimer) pingTimer.cancel();
    },
    onData(chunk) {
      rxBuffer = Buffer.concat([rxBuffer, chunk]);
      const { packets, rest } = decodePackets(rxBuffer);
      rxBuffer = rest;
      for (const pkt of packets) handlePacket(pkt.type, pkt.body);
    },
  };
}

module.exports = { create };
