"use strict";
// Zigbee2MQTT device driver - speaks plain MQTT v3.1.1 over the runtime's
// TCP Connection (QoS 0 only), reusing the same hand-rolled MQTT packet
// encode/decode this project already wrote for ../mqtt-plug/driver.js
// (drivers run in isolated sandboxes with no shared imports between them,
// so this is a deliberate copy of Oak's own code, not a new protocol
// implementation) - just pointed at Zigbee2MQTT's own topic convention
// instead of a generic Tasmota-style one:
//   zigbee2mqtt/<friendlyName>        retained JSON state, e.g. {"state":"ON","brightness":180}
//   zigbee2mqtt/<friendlyName>/set    JSON command, e.g. {"state":"ON"}
//   zigbee2mqtt/<friendlyName>/get    JSON request for a fresh report, e.g. {"state":""}
// One driver instance = one Zigbee device (by friendly_name) - Zigbee2MQTT
// itself is the actual coordinator/bridge; this talks to it over MQTT the
// same way its own frontend and Home Assistant integration do, publicly
// documented at zigbee2mqtt.io, not reverse-engineered.

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
  const baseTopic = ctx.config.settings.baseTopic || "zigbee2mqtt";
  const friendlyName = ctx.config.settings.friendlyName || "";
  const clientId = ctx.config.settings.clientId || "oak-zigbee2mqtt";
  const stateTopic = `${baseTopic}/${friendlyName}`;
  const setTopic = `${stateTopic}/set`;

  let rxBuffer = Buffer.alloc(0);
  let pingTimer = null;

  function publishSet(obj) {
    ctx.connection.send(encodePublish(setTopic, JSON.stringify(obj)));
  }

  function handlePacket(type, body) {
    if (type === 2) {
      ctx.log(`MQTT connected, subscribing to ${stateTopic}`);
      ctx.connection.send(encodeSubscribe(1, stateTopic));
      pingTimer = ctx.clock.every(20000, () => ctx.connection.send(encodePingreq()));
      ctx.emitEvent("connected", {});
    } else if (type === 3) {
      const topicResult = decodeUtf8String(body, 0);
      if (topicResult.value !== stateTopic) return;
      const raw = body.subarray(topicResult.next).toString("utf8");
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch (err) {
        ctx.log(`Non-JSON payload on ${stateTopic}: ${raw}`);
        return;
      }
      if ("state" in payload) ctx.setState("device.on", payload.state === "ON");
      if ("brightness" in payload) ctx.setState("device.brightness", Number(payload.brightness));
      ctx.emitEvent("stateChanged", { payload });
    }
  }

  ctx.onAction("turnOn", () => publishSet({ state: "ON" }));
  ctx.onAction("turnOff", () => publishSet({ state: "OFF" }));
  ctx.onAction("setBrightness", ({ value }) => publishSet({ state: "ON", brightness: value }));
  ctx.onAction("setRaw", ({ json }) => {
    try {
      publishSet(JSON.parse(json));
    } catch (err) {
      ctx.log(`setRaw: invalid JSON - ${err.message}`);
    }
  });

  return {
    onConnect() {
      rxBuffer = Buffer.alloc(0);
      ctx.connection.send(encodeConnect(clientId, 60));
    },
    onDisconnect() {
      if (pingTimer) pingTimer.cancel();
      ctx.emitEvent("disconnected", {});
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
