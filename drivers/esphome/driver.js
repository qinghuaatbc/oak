"use strict";
// ESPHome native API driver (plaintext, unencrypted transport only - the
// newer Noise-protocol-encrypted transport ESPHome also supports is NOT
// implemented here, that's a real DTLS-adjacent handshake well beyond
// this first cut's scope). Framing is ESPHome's own outer envelope
// (0x00 + varint(payload length) + varint(message type) + protobuf
// payload), wrapping a small hand-rolled protobuf encoder/decoder rather
// than a real protobuf library (Oak drivers only have Node core modules
// + `ws` available, no protobuf codegen toolchain to run in this sandbox
// model).
//
// IMPORTANT CONFIDENCE NOTE: the outer envelope framing (length-prefixed,
// type-prefixed) is well-established and documented. The specific
// numeric message-type IDs below (HELLO_REQUEST=1 etc.) are recalled from
// ESPHome's api.proto field ordering, NOT verified against a real device
// or the current api.proto source this session - if a real device's API
// version has since renumbered them, connection will simply stall after
// Hello (a safe failure, not a wrong-command one) rather than silently
// misbehave. Treat these constants as the first thing to check against
// a real device/ESPHome's own api.proto before relying on this driver.
//
// A device's entities are only addressable by a `key` (a fixed32 hash of
// their object_id that the ESP itself computes) - this driver does not
// implement ListEntities-based name resolution, so `entityKey` must be
// supplied directly (visible in the device's ESPHome logs at DEBUG level,
// or via `esphome logs`/the Home Assistant ESPHome integration's key
// display) rather than a friendly name.
const MSG = {
  HELLO_REQUEST: 1,
  HELLO_RESPONSE: 2,
  CONNECT_REQUEST: 3,
  CONNECT_RESPONSE: 4,
  PING_REQUEST: 7,
  PING_RESPONSE: 8,
  SUBSCRIBE_STATES_REQUEST: 20,
  SWITCH_STATE_RESPONSE: 26,
  SWITCH_COMMAND_REQUEST: 33,
  LIGHT_STATE_RESPONSE: 24,
  LIGHT_COMMAND_REQUEST: 32,
};

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
  const data = Buffer.from(str || "", "utf8");
  return Buffer.concat([tag(fieldNum, 2), writeVarint(data.length), data]);
}
function encodeVarintField(fieldNum, value) {
  return Buffer.concat([tag(fieldNum, 0), writeVarint(value ? 1 : Number(value) || 0)]);
}
function encodeFixed32Field(fieldNum, uint32Value) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(uint32Value >>> 0, 0);
  return Buffer.concat([tag(fieldNum, 5), b]);
}
function encodeFloatField(fieldNum, floatValue) {
  const b = Buffer.alloc(4);
  b.writeFloatLE(floatValue, 0);
  return Buffer.concat([tag(fieldNum, 5), b]);
}

// Generic flat-message decoder: returns {fieldNum: rawValue}. varint
// fields decode to a number; fixed32 fields decode to a 4-byte Buffer
// (caller reinterprets as uint32 or float depending on which field it
// knows this is); length-delimited fields decode to a Buffer.
function decodeMessage(buf) {
  const fields = {};
  let pos = 0;
  while (pos < buf.length) {
    const tagResult = readVarint(buf, pos);
    if (!tagResult) break;
    const fieldNum = tagResult.value >>> 3;
    const wireType = tagResult.value & 0x7;
    pos = tagResult.next;
    if (wireType === 0) {
      const v = readVarint(buf, pos);
      if (!v) break;
      fields[fieldNum] = v.value;
      pos = v.next;
    } else if (wireType === 5) {
      fields[fieldNum] = buf.slice(pos, pos + 4);
      pos += 4;
    } else if (wireType === 1) {
      fields[fieldNum] = buf.slice(pos, pos + 8);
      pos += 8;
    } else if (wireType === 2) {
      const lenResult = readVarint(buf, pos);
      if (!lenResult) break;
      fields[fieldNum] = buf.slice(lenResult.next, lenResult.next + lenResult.value);
      pos = lenResult.next + lenResult.value;
    } else {
      break; // unsupported wire type - stop rather than misparse the rest
    }
  }
  return fields;
}

function create(ctx) {
  const entityKey = Number(ctx.config.settings.entityKey) >>> 0;
  let rxBuffer = Buffer.alloc(0);
  let pingTimer = null;

  function sendMessage(type, payload) {
    ctx.connection.send(Buffer.concat([Buffer.from([0x00]), writeVarint(payload.length), writeVarint(type), payload]));
  }

  function handleMessage(type, payload) {
    if (type === MSG.HELLO_RESPONSE) {
      sendMessage(MSG.CONNECT_REQUEST, encodeStringField(1, ctx.config.settings.password || ""));
    } else if (type === MSG.CONNECT_RESPONSE) {
      const fields = decodeMessage(payload);
      if (fields[1]) {
        ctx.log("ESPHome API rejected the password");
        return;
      }
      ctx.log("Connected to ESPHome native API");
      sendMessage(MSG.SUBSCRIBE_STATES_REQUEST, Buffer.alloc(0));
      pingTimer = ctx.clock.every(15000, () => sendMessage(MSG.PING_REQUEST, Buffer.alloc(0)));
      ctx.emitEvent("connected", {});
    } else if (type === MSG.SWITCH_STATE_RESPONSE || type === MSG.LIGHT_STATE_RESPONSE) {
      const fields = decodeMessage(payload);
      const key = fields[1] ? fields[1].readUInt32LE(0) : undefined;
      if (key !== entityKey) return;
      const on = fields[2] === 1;
      ctx.setState("entity.on", on);
      if (type === MSG.LIGHT_STATE_RESPONSE && fields[3]) {
        ctx.setState("entity.brightness", Math.round(fields[3].readFloatLE(0) * 100));
      }
      ctx.emitEvent("stateChanged", { key, state: on });
    }
  }

  ctx.onAction("turnOn", () => sendMessage(MSG.SWITCH_COMMAND_REQUEST, Buffer.concat([encodeFixed32Field(1, entityKey), encodeVarintField(2, true)])));
  ctx.onAction("turnOff", () => sendMessage(MSG.SWITCH_COMMAND_REQUEST, Buffer.concat([encodeFixed32Field(1, entityKey), encodeVarintField(2, false)])));
  ctx.onAction("setBrightness", ({ value }) =>
    sendMessage(
      MSG.LIGHT_COMMAND_REQUEST,
      Buffer.concat([
        encodeFixed32Field(1, entityKey),
        encodeVarintField(2, true), // has_state
        encodeVarintField(3, true), // state = on
        encodeVarintField(4, true), // has_brightness
        encodeFloatField(5, Math.max(0, Math.min(100, value)) / 100),
      ])
    )
  );

  return {
    onConnect() {
      rxBuffer = Buffer.alloc(0);
      sendMessage(MSG.HELLO_REQUEST, encodeStringField(1, "oak"));
    },
    onDisconnect() {
      if (pingTimer) pingTimer.cancel();
    },
    onData(chunk) {
      rxBuffer = Buffer.concat([rxBuffer, chunk]);
      while (rxBuffer.length >= 3 && rxBuffer[0] === 0x00) {
        const lenResult = readVarint(rxBuffer, 1);
        if (!lenResult) break;
        const typeResult = readVarint(rxBuffer, lenResult.next);
        if (!typeResult) break;
        const payloadStart = typeResult.next;
        const payloadEnd = payloadStart + lenResult.value;
        if (rxBuffer.length < payloadEnd) break;
        handleMessage(typeResult.value, rxBuffer.slice(payloadStart, payloadEnd));
        rxBuffer = rxBuffer.slice(payloadEnd);
      }
    },
  };
}

module.exports = { create };
