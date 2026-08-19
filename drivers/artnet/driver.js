"use strict";
// Art-Net (DMX-over-Ethernet) driver, sending ArtDMX (OpOutput) packets
// over UDP - HIGH confidence: the packet layout below is read directly
// from the official Art-Net 4 Specification (art-net.org.uk), including
// its mixed endianness (OpCode is little-endian, everything else is
// big-endian) which is a real quirk of the spec worth getting right.
//
// UDP-only device (see ../xiaomi-miio's header comment for this pattern):
// manifest declares transport:"http" so the platform never opens a real
// TCP connection; this driver manages its own dgram socket directly.
//
// Keeps a persistent 512-byte DMX buffer per instance (module-scope
// would leak this across every instance of this driver loaded in the
// same process - see ../global-cache's header comment for why this must
// live inside create(ctx), not at module scope) and resends the FULL
// buffer on every change, which is the conventional way to drive a DMX
// universe (a receiver expects to see the whole universe's state, not a
// diff).
const dgram = require("dgram");

const ART_NET_ID = Buffer.from("Art-Net\0", "ascii");
const OP_OUTPUT = 0x5000;
const PROT_VER = 14;

function buildArtDmx(universe, sequence, dmxData) {
  const header = Buffer.alloc(18);
  ART_NET_ID.copy(header, 0);
  header.writeUInt8(OP_OUTPUT & 0xff, 8); // OpCode low byte first (little-endian)
  header.writeUInt8((OP_OUTPUT >> 8) & 0xff, 9);
  header.writeUInt8((PROT_VER >> 8) & 0xff, 10); // ProtVerHi
  header.writeUInt8(PROT_VER & 0xff, 11); // ProtVerLo
  header.writeUInt8(sequence, 12);
  header.writeUInt8(0, 13); // Physical
  header.writeUInt8(universe & 0xff, 14); // SubUni
  header.writeUInt8((universe >> 8) & 0x7f, 15); // Net
  header.writeUInt8((dmxData.length >> 8) & 0xff, 16); // Length hi
  header.writeUInt8(dmxData.length & 0xff, 17); // Length lo
  return Buffer.concat([header, dmxData]);
}

function create(ctx) {
  const dmxBuffer = Buffer.alloc(512, 0);
  let sequence = 1; // 0 means "sequencing disabled" per spec - start at 1 and wrap 1..255
  let socket = null;

  function sendUniverse() {
    if (!socket) return;
    const host = ctx.config.connection.host;
    const port = ctx.config.connection.port || 6454;
    const universe = Number(ctx.config.settings.universe) || 0;
    const packet = buildArtDmx(universe, sequence, dmxBuffer);
    sequence = sequence >= 255 ? 1 : sequence + 1;
    socket.send(packet, port, host, (err) => {
      if (err) ctx.log(`send failed: ${err.message}`);
    });
  }

  ctx.onAction("setChannel", ({ channel, value }) => {
    const idx = Math.max(1, Math.min(512, Math.round(channel))) - 1;
    dmxBuffer[idx] = Math.max(0, Math.min(255, Math.round(value)));
    sendUniverse();
    ctx.setState("device.level", dmxBuffer[idx], String(channel));
  });

  ctx.onAction("setChannels", ({ start = 1, values }) => {
    const nums = String(values || "")
      .split(",")
      .map((s) => Math.max(0, Math.min(255, Math.round(Number(s.trim())) || 0)));
    const startIdx = Math.max(1, Math.min(512, Math.round(start))) - 1;
    for (let i = 0; i < nums.length && startIdx + i < 512; i++) dmxBuffer[startIdx + i] = nums[i];
    sendUniverse();
  });

  ctx.onAction("blackout", () => {
    dmxBuffer.fill(0);
    sendUniverse();
  });

  return {
    onConnect() {
      socket = dgram.createSocket("udp4");
      socket.on("error", (err) => ctx.log(`socket error: ${err.message}`));
      // Art-Net broadcast sockets need SO_BROADCAST when the target is a
      // broadcast address (e.g. 2.255.255.255) - harmless to enable even
      // for a unicast target.
      socket.bind(() => {
        try {
          socket.setBroadcast(true);
        } catch (err) {
          /* not fatal - unicast targets don't need this */
        }
      });
    },
    onDisconnect() {
      if (socket) {
        socket.close();
        socket = null;
      }
    },
  };
}

module.exports = { create };
