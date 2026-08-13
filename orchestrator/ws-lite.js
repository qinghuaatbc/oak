"use strict";
// Minimal WebSocket server (RFC 6455) - handshake + unfragmented text
// frames only, enough for server-to-client push over a browser's native
// WebSocket API. No ping/pong keepalive or fragmented-message support in
// this first cut. Written directly from the public RFC; no third-party
// WebSocket library involved.

const crypto = require("crypto");
const { EventEmitter } = require("events");

const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// opcode 0x1 = text (JSON control channel), 0x2 = binary (camera-ws's raw
// fragmented-MP4 video bytes) - same header shape either way.
function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (buffer.length - offset < 2) break;
    const b0 = buffer[offset];
    const b1 = buffer[offset + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let pos = offset + 2;
    if (len === 126) {
      if (buffer.length - pos < 2) break;
      len = buffer.readUInt16BE(pos);
      pos += 2;
    } else if (len === 127) {
      if (buffer.length - pos < 8) break;
      len = Number(buffer.readBigUInt64BE(pos));
      pos += 8;
    }
    let maskKey;
    if (masked) {
      if (buffer.length - pos < 4) break;
      maskKey = buffer.subarray(pos, pos + 4);
      pos += 4;
    }
    if (buffer.length - pos < len) break;
    let payload = buffer.subarray(pos, pos + len);
    if (masked) {
      const unmasked = Buffer.alloc(len);
      for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
      payload = unmasked;
    }
    frames.push({ opcode, payload });
    offset = pos + len;
  }
  return { frames, rest: buffer.subarray(offset) };
}

class WSConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => this._onData(chunk));
    socket.on("close", () => this.emit("close"));
    socket.on("error", (err) => this.emit("error", err));
  }
  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const { frames, rest } = decodeFrames(this.buffer);
    this.buffer = rest;
    for (const frame of frames) {
      if (frame.opcode === 0x8) {
        this.socket.end();
        this.emit("close");
      } else if (frame.opcode === 0x1) {
        this.emit("message", frame.payload.toString("utf8"));
      }
      // 0x9/0xA (ping/pong) intentionally unhandled in this minimal version
    }
  }
  send(payload) {
    if (!this.socket.destroyed) this.socket.write(encodeFrame(0x1, payload));
  }
  sendBinary(buffer) {
    if (!this.socket.destroyed) this.socket.write(encodeFrame(0x2, buffer));
  }
  close() {
    this.socket.end();
  }
}

function isWebSocketUpgrade(req) {
  return (req.headers.upgrade || "").toLowerCase() === "websocket";
}

function acceptUpgrade(req, socket) {
  const key = req.headers["sec-websocket-key"];
  const accept = crypto.createHash("sha1").update(key + WS_MAGIC).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  return new WSConnection(socket);
}

module.exports = { isWebSocketUpgrade, acceptUpgrade };
