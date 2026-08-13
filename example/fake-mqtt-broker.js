"use strict";
// Minimal fake MQTT v3.1.1 broker for testing mqtt-plug without a real
// broker or device: accepts one connection, ACKs CONNECT/SUBSCRIBE,
// answers PINGREQ, and simulates a real device by publishing an initial
// "OFF" state after subscribe and echoing state changes back whenever a
// message arrives on the "/set" topic.
const net = require("net");

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
function encodePublish(topic, message) {
  const topicBuf = encodeUtf8String(topic);
  const payload = Buffer.from(message, "utf8");
  const remaining = topicBuf.length + payload.length;
  return Buffer.concat([Buffer.from([0x30]), encodeRemainingLength(remaining), topicBuf, payload]);
}
function decodeUtf8String(buf, offset) {
  const len = buf.readUInt16BE(offset);
  return { value: buf.toString("utf8", offset + 2, offset + 2 + len), next: offset + 2 + len };
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

const server = net.createServer((socket) => {
  let rxBuffer = Buffer.alloc(0);
  let stateTopic = null;
  let deviceOn = false;

  socket.on("data", (chunk) => {
    rxBuffer = Buffer.concat([rxBuffer, chunk]);
    const { packets, rest } = decodePackets(rxBuffer);
    rxBuffer = rest;
    for (const pkt of packets) {
      if (pkt.type === 1) {
        // CONNECT -> CONNACK
        socket.write(Buffer.from([0x20, 0x02, 0x00, 0x00]));
      } else if (pkt.type === 8) {
        // SUBSCRIBE -> SUBACK, then announce initial state
        const packetId = pkt.body.readUInt16BE(0);
        const topicResult = decodeUtf8String(pkt.body, 2);
        stateTopic = topicResult.value;
        socket.write(Buffer.from([0x90, 0x03, (packetId >> 8) & 0xff, packetId & 0xff, 0x00]));
        setTimeout(() => socket.write(encodePublish(stateTopic, deviceOn ? "ON" : "OFF")), 200);
      } else if (pkt.type === 3) {
        // PUBLISH from client (command topic) -> flip device, report back
        const topicResult = decodeUtf8String(pkt.body, 0);
        const payload = pkt.body.subarray(topicResult.next).toString("utf8").trim();
        if (topicResult.value.endsWith("/set") && stateTopic) {
          deviceOn = payload.toUpperCase() === "ON";
          setTimeout(() => socket.write(encodePublish(stateTopic, deviceOn ? "ON" : "OFF")), 100);
        }
      } else if (pkt.type === 12) {
        // PINGREQ -> PINGRESP
        socket.write(Buffer.from([0xd0, 0x00]));
      }
    }
  });
});

const port = parseInt(process.env.PORT || "1883", 10);
server.listen(port, "127.0.0.1", () => console.log(`[fake-mqtt-broker] listening on 127.0.0.1:${port}`));
