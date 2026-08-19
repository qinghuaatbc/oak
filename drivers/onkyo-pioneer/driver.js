"use strict";
// Onkyo/Pioneer/Integra AVR driver over eISCP - HIGH confidence: packet
// framing verified against the python-eiscp reference implementation
// (miracle2k/onkyo-eiscp), which matches Onkyo's own published Integra
// Serial Control Protocol doc.
function buildPacket(command) {
  const data = Buffer.from(`!1${command}\r`, "ascii");
  const header = Buffer.alloc(16);
  header.write("ISCP", 0, "ascii");
  header.writeUInt32BE(16, 4); // header size, always 16
  header.writeUInt32BE(data.length, 8);
  header.writeUInt8(0x01, 12); // version
  return Buffer.concat([header, data]);
}
function toVolumeHex(level) {
  return Math.max(0, Math.min(100, Math.round(level))).toString(16).padStart(2, "0").toUpperCase();
}

function create(ctx) {
  let rxBuffer = Buffer.alloc(0);

  function send(command) {
    ctx.connection.send(buildPacket(command));
  }

  ctx.onAction("powerOn", () => send("PWR01"));
  ctx.onAction("powerOff", () => send("PWR00"));
  ctx.onAction("setVolume", ({ level }) => send(`MVL${toVolumeHex(level)}`));
  ctx.onAction("volumeUp", () => send("MVLUP"));
  ctx.onAction("volumeDown", () => send("MVLDOWN"));
  ctx.onAction("setInput", ({ code }) => send(`SLI${code}`));

  function handleCommand(text) {
    // text is like "!1PWR01\r" - strip the "!1" prefix and trailing control char
    const body = text.replace(/^!1/, "").replace(/[\r\x1a]+$/, "");
    if (body.startsWith("PWR")) ctx.setState("power", body.slice(3) === "01");
    else if (body.startsWith("MVL")) {
      const hex = body.slice(3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) ctx.setState("volume", parseInt(hex, 16));
    } else if (body.startsWith("SLI")) ctx.setState("input", body.slice(3));
  }

  return {
    onConnect() {
      rxBuffer = Buffer.alloc(0);
    },
    onDisconnect() {},
    onData(chunk) {
      rxBuffer = Buffer.concat([rxBuffer, chunk]);
      while (rxBuffer.length >= 16) {
        const headerSize = rxBuffer.readUInt32BE(4);
        const dataSize = rxBuffer.readUInt32BE(8);
        const totalSize = headerSize + dataSize;
        if (rxBuffer.length < totalSize) break;
        const data = rxBuffer.slice(headerSize, totalSize);
        rxBuffer = rxBuffer.slice(totalSize);
        handleCommand(data.toString("ascii"));
      }
    },
  };
}

module.exports = { create };
