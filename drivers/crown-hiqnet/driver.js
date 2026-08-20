"use strict";
// Crown (Harman) amplifier driver over HiQnet, TCP port 3804 - the ONLY
// documented external-control path for these amps (confirmed via direct
// research against all 3 of QSC's standalone-amp manuals: none of them
// document ANY control protocol at all, RS-232 or network - standalone
// QSC amps genuinely have nothing to build against). HIGH confidence on
// the wire protocol itself: header layout, MultiParamSet (0x0100) and
// MultiParamGet (0x0103) message IDs read directly from Harman's own
// public "HiQnet Third Party Programmers Guide" PDF.
//
// EXPLICITLY NOT CONFIRMED, AND THE REAL RISK IN THIS DRIVER: the
// per-model Parameter_ID map (which numeric ID means "Channel 1 Mute" vs
// "Channel 2 Gain" on a SPECIFIC Crown model) is not published in
// Harman's own doc - it lives inside that model's product-definition
// data, extractable from Harman's free System Architect software (a
// real, documented, repeatable method - see the node-hiqnet project's
// README for the exact extraction steps - but a one-time step this
// driver cannot do for you). This driver only implements the verified
// protocol ENVELOPE (setParameter/getParameter by raw numeric Parameter
// ID) rather than guessing at named actions like "mute"/"power" that
// would require knowing that mapping for your exact model. Also
// unverified: the exact numeric Param_DataType byte for a signed 32-bit
// value (assumed 0x04 here, following the common Byte=0/UByte=1/Word=2/
// UWord=3/Long=4 ordering seen in other HiQnet client implementations,
// not independently confirmed against Harman's own enum table) - if
// values come back wrong, this byte is the first thing to check.
function hexToBytes(hex, expectedLen) {
  const buf = Buffer.from((hex || "").padStart(expectedLen * 2, "0"), "hex");
  return buf.length === expectedLen ? buf : Buffer.alloc(expectedLen, 0);
}

const MSG_MULTI_PARAM_SET = 0x0100;
const MSG_MULTI_PARAM_GET = 0x0103;
const DATATYPE_LONG = 0x04; // unverified - see header comment

function create(ctx) {
  let rxBuffer = Buffer.alloc(0);
  let sequenceNumber = 0;

  function destAddress() {
    const { destDevice, destVd, destObject } = ctx.config.settings;
    return Buffer.concat([hexToBytes(destDevice, 2), hexToBytes(destVd, 1), hexToBytes(destObject, 3)]);
  }
  // Source address is this driver's own pseudo-identity on the HiQnet
  // network - only used for reply routing, arbitrary but fixed.
  const SOURCE_ADDR = Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x00, 0x00]);

  function buildMessage(messageId, payload) {
    sequenceNumber = (sequenceNumber + 1) & 0xffff;
    const header = Buffer.alloc(25);
    header[0] = 0x02; // version
    header[1] = 0x19; // header length (25)
    // message length filled in below once payload size is known
    SOURCE_ADDR.copy(header, 6);
    destAddress().copy(header, 12);
    header.writeUInt16BE(messageId, 18);
    header.writeUInt16BE(0x0000, 20); // flags
    header[22] = 0x05; // hop count
    header.writeUInt16BE(sequenceNumber, 23);
    const full = Buffer.concat([header, payload]);
    full.writeUInt32BE(full.length, 2); // message length includes header
    return full;
  }

  ctx.onAction("setParameter", ({ paramId, value }) => {
    const valueBuf = Buffer.alloc(4);
    valueBuf.writeInt32BE(value | 0, 0);
    const payload = Buffer.concat([
      Buffer.from([0x00, 0x01]), // NumParams = 1
      Buffer.from([(paramId >> 8) & 0xff, paramId & 0xff]),
      Buffer.from([DATATYPE_LONG]),
      valueBuf,
    ]);
    ctx.connection.send(buildMessage(MSG_MULTI_PARAM_SET, payload));
  });
  ctx.onAction("getParameter", ({ paramId }) => {
    const payload = Buffer.concat([Buffer.from([0x00, 0x01]), Buffer.from([(paramId >> 8) & 0xff, paramId & 0xff])]);
    ctx.connection.send(buildMessage(MSG_MULTI_PARAM_GET, payload));
  });

  function handleMessage(buf) {
    if (buf.length < 25) return;
    const messageId = buf.readUInt16BE(18);
    if (messageId !== MSG_MULTI_PARAM_SET && messageId !== MSG_MULTI_PARAM_GET) return;
    const payload = buf.slice(25);
    if (payload.length < 2) return;
    const numParams = payload.readUInt16BE(0);
    let pos = 2;
    for (let i = 0; i < numParams && pos + 3 <= payload.length; i++) {
      const paramId = payload.readUInt16BE(pos);
      const dataType = payload[pos + 2];
      pos += 3;
      const size = dataType === DATATYPE_LONG ? 4 : 2; // best-effort - see header comment
      if (pos + size > payload.length) break;
      const value = size === 4 ? payload.readInt32BE(pos) : payload.readInt16BE(pos);
      pos += size;
      ctx.setState("parameter.value", value, String(paramId));
    }
  }

  return {
    onConnect() {
      rxBuffer = Buffer.alloc(0);
    },
    onDisconnect() {},
    onData(chunk) {
      rxBuffer = Buffer.concat([rxBuffer, chunk]);
      while (rxBuffer.length >= 6) {
        const totalLen = rxBuffer.readUInt32BE(2);
        if (totalLen < 25 || rxBuffer.length < totalLen) break;
        const message = rxBuffer.slice(0, totalLen);
        rxBuffer = rxBuffer.slice(totalLen);
        handleMessage(message);
      }
    },
  };
}

module.exports = { create };
