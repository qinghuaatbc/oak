"use strict";
// Middle Atlantic Premium+ rack PDU driver over SNMPv2c - this is a
// genuinely different kind of protocol than most drivers in this
// project: Premium+ is confirmed (via AV trade press) to be built on
// Raritan's Xerus platform (effectively an OEM'd Raritan PX3-family PDU
// running Raritan firmware), which uses Raritan's standard PDU2-MIB over
// plain SNMP rather than a proprietary serial/IP command set. Oak has no
// SNMP library dependency (only ws/web-push/node-coap-client are
// installed, matching this project's minimal-dependency style), so this
// driver hand-rolls the small subset of SNMPv2c BER encoding needed for
// a GET/SET on a handful of fixed OIDs - the same "implement the
// protocol primitive by hand" approach already used elsewhere in this
// project for MQTT, digest auth, and AES envelopes.
//
// CONFIDENCE: HIGH that this is a genuine Raritan PDU2-MIB device
// (sourced from Raritan's own official SNMP MIB User Guide PDF).
// MODERATE specifically on whether Middle Atlantic ships the identical,
// unmodified OID tree - their own Premium+ manual documents an "SNMP
// Gets and Sets" chapter but only as scanned page images, so the exact
// OID numbers below (from Raritan's own PDF) were not independently
// cross-checked against a Middle-Atlantic-specific rebrand. Recommend
// walking the actual unit's MIB with a generic SNMP browser once before
// trusting this on a real installation. Applies to Premium+-branded
// units specifically - Middle Atlantic's older RackLink PDUs use a
// different, MA-proprietary MIB not covered here.
const dgram = require("dgram");
const crypto = require("crypto");

const ENTERPRISE_OID = "1.3.6.1.4.1.13742.6";
function outletStateOid(pduId, outlet) {
  return `${ENTERPRISE_OID}.4.1.2.1.3.1.${outlet}`; // outletSwitchingState.<pduId>.<outlet> (pduId folded into instance per PDU2-MIB indexing)
}
function outletSwitchOid(pduId, outlet) {
  return `${ENTERPRISE_OID}.4.1.2.1.2.1.${outlet}`; // switchingOperation.<pduId>.<outlet>
}

// --- minimal SNMPv2c BER encode/decode -------------------------------
function encodeLength(len) {
  if (len < 128) return Buffer.from([len]);
  const bytes = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n = n >>> 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function encodeTLV(tag, value) {
  return Buffer.concat([Buffer.from([tag]), encodeLength(value.length), value]);
}
function encodeInteger(n) {
  if (n === 0) return encodeTLV(0x02, Buffer.from([0x00]));
  const bytes = [];
  let v = Math.abs(n);
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = v >>> 8;
  }
  if (bytes[0] & 0x80) bytes.unshift(0x00);
  return encodeTLV(0x02, Buffer.from(bytes));
}
function encodeOctetString(str) {
  return encodeTLV(0x04, Buffer.from(str, "utf8"));
}
function encodeNull() {
  return encodeTLV(0x05, Buffer.alloc(0));
}
function encodeOid(oid) {
  const parts = oid.split(".").map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let n = parts[i];
    const chunk = [n & 0x7f];
    n = n >>> 7;
    while (n > 0) {
      chunk.unshift((n & 0x7f) | 0x80);
      n = n >>> 7;
    }
    bytes.push(...chunk);
  }
  return encodeTLV(0x06, Buffer.from(bytes));
}
function encodeSequence(tag, parts) {
  return encodeTLV(tag, Buffer.concat(parts));
}
function buildMessage(community, pduTag, pduParts) {
  const pdu = encodeSequence(pduTag, pduParts);
  return encodeSequence(0x30, [encodeInteger(1), encodeOctetString(community), pdu]); // version=1 means SNMPv2c
}
function buildGetRequest(community, oid, requestId) {
  const varbind = encodeSequence(0x30, [encodeOid(oid), encodeNull()]);
  const varbindList = encodeSequence(0x30, [varbind]);
  return buildMessage(community, 0xa0, [encodeInteger(requestId), encodeInteger(0), encodeInteger(0), varbindList]);
}
function buildSetRequest(community, oid, value, requestId) {
  const varbind = encodeSequence(0x30, [encodeOid(oid), encodeInteger(value)]);
  const varbindList = encodeSequence(0x30, [varbind]);
  return buildMessage(community, 0xa3, [encodeInteger(requestId), encodeInteger(0), encodeInteger(0), varbindList]);
}
function decodeLength(buf, offset) {
  const first = buf[offset];
  if (first < 0x80) return { length: first, next: offset + 1 };
  const numBytes = first & 0x7f;
  let length = 0;
  for (let i = 0; i < numBytes; i++) length = (length << 8) | buf[offset + 1 + i];
  return { length, next: offset + 1 + numBytes };
}
function decodeTLV(buf, offset) {
  const tag = buf[offset];
  const { length, next } = decodeLength(buf, offset + 1);
  return { tag, valueStart: next, valueEnd: next + length, next: next + length };
}
function decodeInteger(buf, start, end) {
  let n = 0;
  for (let i = start; i < end; i++) n = (n << 8) | buf[i];
  return n;
}
function parseResponse(buf) {
  const outer = decodeTLV(buf, 0);
  let pos = outer.valueStart;
  let tlv = decodeTLV(buf, pos); // version
  pos = tlv.next;
  tlv = decodeTLV(buf, pos); // community
  pos = tlv.next;
  const pdu = decodeTLV(buf, pos); // GetResponse-PDU (0xA2)
  pos = pdu.valueStart;
  tlv = decodeTLV(buf, pos); // request-id
  const requestId = decodeInteger(buf, tlv.valueStart, tlv.valueEnd);
  pos = tlv.next;
  tlv = decodeTLV(buf, pos); // error-status
  const errorStatus = decodeInteger(buf, tlv.valueStart, tlv.valueEnd);
  pos = tlv.next;
  tlv = decodeTLV(buf, pos); // error-index
  pos = tlv.next;
  const varbindList = decodeTLV(buf, pos);
  const varbind = decodeTLV(buf, varbindList.valueStart);
  const oidTlv = decodeTLV(buf, varbind.valueStart);
  const valueTlv = decodeTLV(buf, oidTlv.next);
  const value = valueTlv.tag === 0x02 ? decodeInteger(buf, valueTlv.valueStart, valueTlv.valueEnd) : buf.slice(valueTlv.valueStart, valueTlv.valueEnd);
  return { requestId, errorStatus, value };
}
// -----------------------------------------------------------------------

function create(ctx) {
  let socket = null;
  const pending = new Map(); // requestId -> {resolve, outlet, kind}

  function nextRequestId() {
    return crypto.randomInt(1, 0x7fffffff);
  }
  function sendSnmp(packet, requestId, meta) {
    if (!socket) return;
    const host = ctx.config.connection.host;
    const port = ctx.config.connection.port || 161;
    pending.set(requestId, meta);
    socket.send(packet, port, host, (err) => {
      if (err) {
        pending.delete(requestId);
        ctx.log(`SNMP send failed: ${err.message}`);
      }
    });
    ctx.clock.after(5000, () => pending.delete(requestId)); // give up waiting on a lost reply
  }

  function pduId() {
    return Number(ctx.config.settings.pduId) || 1;
  }

  ctx.onAction("outletOn", ({ outlet }) => {
    const requestId = nextRequestId();
    sendSnmp(buildSetRequest(ctx.config.settings.writeCommunity || "private", outletSwitchOid(pduId(), outlet), 1, requestId), requestId, { outlet });
  });
  ctx.onAction("outletOff", ({ outlet }) => {
    const requestId = nextRequestId();
    sendSnmp(buildSetRequest(ctx.config.settings.writeCommunity || "private", outletSwitchOid(pduId(), outlet), 0, requestId), requestId, { outlet });
  });
  ctx.onAction("outletCycle", ({ outlet }) => {
    const requestId = nextRequestId();
    sendSnmp(buildSetRequest(ctx.config.settings.writeCommunity || "private", outletSwitchOid(pduId(), outlet), 2, requestId), requestId, { outlet });
  });
  ctx.onAction("queryOutlet", ({ outlet }) => {
    const requestId = nextRequestId();
    sendSnmp(buildGetRequest(ctx.config.settings.readCommunity || "public", outletStateOid(pduId(), outlet), requestId), requestId, { outlet, isQuery: true });
  });

  return {
    onConnect() {
      socket = dgram.createSocket("udp4");
      socket.on("error", (err) => ctx.log(`socket error: ${err.message}`));
      socket.on("message", (msg, rinfo) => {
        try {
          const { requestId, errorStatus, value } = parseResponse(msg);
          const meta = pending.get(requestId);
          if (!meta) return;
          pending.delete(requestId);
          if (errorStatus !== 0) {
            ctx.log(`SNMP error status ${errorStatus} for outlet ${meta.outlet}`);
            return;
          }
          if (meta.isQuery && typeof value === "number") ctx.setState("outlet.state", value, String(meta.outlet));
        } catch (err) {
          ctx.log(`Failed to parse SNMP response: ${err.message}`);
        }
      });
      socket.bind();
    },
    onDisconnect() {
      if (socket) {
        socket.close();
        socket = null;
      }
      pending.clear();
    },
  };
}

module.exports = { create };
