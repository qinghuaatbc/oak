"use strict";
// TP-Link Kasa driver over its local TCP JSON protocol (port 9999) -
// never published by TP-Link, but extremely well documented and stable
// across years of python-kasa/other community use, high confidence. The
// "encryption" is a well-known autokey XOR obfuscation (not real
// cryptography) starting from key byte 0xAB - documented here exactly as
// python-kasa implements it.
function xorEncrypt(str) {
  let key = 0xab;
  const buf = Buffer.from(str, "utf8");
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[i] ^ key;
    key = out[i];
  }
  return out;
}
function xorDecrypt(buf) {
  let key = 0xab;
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[i] ^ key;
    key = buf[i];
  }
  return out.toString("utf8");
}
function frame(obj) {
  const encrypted = xorEncrypt(JSON.stringify(obj));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(encrypted.length, 0);
  return Buffer.concat([len, encrypted]);
}

function create(ctx) {
  let rxBuffer = Buffer.alloc(0);

  function send(cmd) {
    ctx.connection.send(frame(cmd));
  }

  ctx.onAction("turnOn", () => send({ system: { set_relay_state: { state: 1 } } }));
  ctx.onAction("turnOff", () => send({ system: { set_relay_state: { state: 0 } } }));
  ctx.onAction("setBrightness", ({ value }) =>
    send({ "smartlife.iot.smartbulb.lightingservice": { transition_light_state: { on_off: 1, brightness: Math.max(0, Math.min(100, Math.round(value))) } } })
  );
  ctx.onAction("refresh", () => send({ system: { get_sysinfo: {} } }));

  return {
    onConnect() {
      rxBuffer = Buffer.alloc(0);
      send({ system: { get_sysinfo: {} } });
    },
    onDisconnect() {},
    onData(chunk) {
      rxBuffer = Buffer.concat([rxBuffer, chunk]);
      while (rxBuffer.length >= 4) {
        const len = rxBuffer.readUInt32BE(0);
        if (rxBuffer.length < 4 + len) break;
        const payload = rxBuffer.slice(4, 4 + len);
        rxBuffer = rxBuffer.slice(4 + len);
        try {
          const msg = JSON.parse(xorDecrypt(payload));
          const sysinfo = msg.system && msg.system.get_sysinfo;
          if (sysinfo) {
            if (sysinfo.relay_state !== undefined) ctx.setState("device.on", sysinfo.relay_state === 1);
            if (sysinfo.light_state) ctx.setState("device.on", Boolean(sysinfo.light_state.on_off));
          }
          const bulbState = msg["smartlife.iot.smartbulb.lightingservice"];
          if (bulbState && bulbState.transition_light_state) {
            ctx.setState("device.on", Boolean(bulbState.transition_light_state.on_off));
            if (bulbState.transition_light_state.brightness !== undefined) ctx.setState("device.brightness", bulbState.transition_light_state.brightness);
          }
        } catch (err) {
          ctx.log(`Failed to decode Kasa response: ${err.message}`);
        }
      }
    },
  };
}

module.exports = { create };
