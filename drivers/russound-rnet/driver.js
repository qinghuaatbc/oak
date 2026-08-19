"use strict";
// Russound RNET (legacy whole-house audio matrix, RS232/RS232-over-IP) -
// THE LOWEST-CONFIDENCE DRIVER IN THIS PROJECT, deliberately scoped down
// because of it. Research turned up no complete official public protocol
// spec, only a mix of a community GitHub mirror of an old internal hex
// reference and forum/community reverse-engineering summaries repeated
// across several independent sources - consistent enough to trust the
// OUTER FRAME SHAPE (start byte 0xF0, end byte 0xF7, a checksum computed
// as the sum of all body bytes mod 128, and 0xF1 byte-stuffing for any
// data byte with its high bit set), but NOT enough to trust any specific
// claim about which byte positions mean "zone" or "power" or "source" -
// one worked example packet was found in community sources but never
// independently decoded field-by-field against an authoritative source.
//
// Rather than guess at that mapping (the same call made for Apple TV's
// pairing handshake and Paradox/HAI's real-time event maps elsewhere in
// this project - when a guess could easily be wrong and there's no way
// to verify it without real hardware, don't ship the guess), this driver
// only implements the parts that ARE reasonably confirmed: correct
// framing, checksum, and byte-stuffing. It exposes a single
// "sendRawPacket" action that takes the message body as hex (the part
// between start/end that an installer with Russound's actual
// "RS-232 Communication Quick Start and Hex Code Listing" document would
// need to construct) - the driver builds a correctly-framed packet
// around it, but does not claim to know what any specific command means.
// Note also: Russound's post-2015 controllers mostly use a newer,
// better-documented ASCII protocol called RIO instead of RNET - if the
// target hardware supports RIO, that would be a better foundation for a
// future, higher-confidence driver than this one.
function checksum(bytes) {
  let sum = 0;
  for (const b of bytes) sum += b;
  return sum % 128;
}
function byteStuff(bytes) {
  const out = [];
  for (const b of bytes) {
    if (b > 0x7f) {
      out.push(0xf1);
      out.push((~b) & 0xff);
    } else {
      out.push(b);
    }
  }
  return out;
}
function buildPacket(bodyBytes) {
  const stuffed = byteStuff(bodyBytes);
  const cs = checksum(bodyBytes);
  return Buffer.from([0xf0, ...stuffed, cs, 0xf7]);
}

function create(ctx) {
  ctx.onAction("sendRawPacket", ({ hexBody }) => {
    const bytes = String(hexBody || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((h) => parseInt(h, 16))
      .filter((n) => !isNaN(n));
    if (!bytes.length) {
      ctx.log("sendRawPacket: no valid hex bytes provided");
      return;
    }
    ctx.connection.send(buildPacket(bytes));
  });

  return {
    onConnect() {},
    onDisconnect() {},
    onData() {},
  };
}

module.exports = { create };
