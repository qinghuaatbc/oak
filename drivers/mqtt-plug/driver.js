"use strict";
// Generic MQTT plug/sensor driver - speaks plain MQTT v3.1.1 over the
// runtime's TCP Connection, proving that abstraction is byte-shaped, not
// secretly text-protocol-shaped like the DSC driver's framing might
// suggest. Topic convention (device publishes "<base>/state" as "ON"/
// "OFF", accepts commands on "<base>/set") mirrors what Tasmota/ESPHome/
// Zigbee2MQTT already use by common convention - not derived from any
// single vendor's proprietary code.
//
// The packet encode/decode below is written directly from the public
// OASIS MQTT v3.1.1 spec (protocol facts). QoS 0 only in this first cut -
// no retry/ack tracking, no QoS 1/2, no username/password auth yet.

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
    Buffer.from([0x04]), // protocol level 4 = MQTT 3.1.1
    Buffer.from([0x02]), // connect flags: clean session, no will/auth
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
  return Buffer.concat([Buffer.from([0x30]), encodeRemainingLength(remaining), topicBuf, payload]); // QoS 0
}

function encodeSubscribe(packetId, topic) {
  const variableHeader = Buffer.from([(packetId >> 8) & 0xff, packetId & 0xff]);
  const payload = Buffer.concat([encodeUtf8String(topic), Buffer.from([0x00])]); // requested QoS 0
  const remaining = variableHeader.length + payload.length;
  return Buffer.concat([Buffer.from([0x82]), encodeRemainingLength(remaining), variableHeader, payload]);
}

function encodePingreq() {
  return Buffer.from([0xc0, 0x00]);
}

// Decodes as many complete packets as are present in `buffer`. Assumes the
// remaining-length varint fits in 1-4 bytes, true for anything this driver
// sends or expects to receive.
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
  const baseTopic = (ctx.config.settings && ctx.config.settings.baseTopic) || "home/plug1";
  const clientId = (ctx.config.settings && ctx.config.settings.clientId) || "oak-mqtt-plug";
  const stateTopic = `${baseTopic}/state`;
  const setTopic = `${baseTopic}/set`;

  let rxBuffer = Buffer.alloc(0);
  let pingTimer = null;
  let lastOn = null;

  function handlePacket(type, body) {
    if (type === 2) {
      // CONNACK
      ctx.log("MQTT connected, subscribing to", stateTopic);
      ctx.connection.send(encodeSubscribe(1, stateTopic));
      pingTimer = ctx.clock.every(20000, () => ctx.connection.send(encodePingreq()));
      ctx.emitEvent("connected", {});
    } else if (type === 3) {
      // PUBLISH
      const topicResult = decodeUtf8String(body, 0);
      if (topicResult.value !== stateTopic) return;
      const payload = body.subarray(topicResult.next).toString("utf8").trim();
      const on = payload.toUpperCase() === "ON";
      if (lastOn !== on) {
        lastOn = on;
        ctx.setState("plug.on", on);
        ctx.emitEvent("stateChanged", { on });
      }
    }
    // SUBACK/PINGRESP need no action in this QoS-0-only first cut.
  }

  ctx.onAction("turnOn", () => ctx.connection.send(encodePublish(setTopic, "ON")));
  ctx.onAction("turnOff", () => ctx.connection.send(encodePublish(setTopic, "OFF")));

  return {
    onConnect() {
      rxBuffer = Buffer.alloc(0);
      lastOn = null;
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
