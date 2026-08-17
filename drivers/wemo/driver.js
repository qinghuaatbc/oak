"use strict";
// Belkin Wemo driver over its local UPnP/SOAP "basicevent" service - not
// published by Belkin as a public spec, but reverse-engineered and
// completely stable across years of pywemo/community use, high
// confidence. Plain HTTP POST with a SOAPACTION header, no discovery
// (UPnP SSDP multicast is skipped - same "manual IP, no discovery" scope
// choice as every other local-network driver in this project).
function create(ctx) {
  const host = ctx.config.connection.host;
  const port = ctx.config.connection.port || 49153;
  const url = `http://${host}:${port}/upnp/control/basicevent1`;

  function envelope(action, body) {
    return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body><u:${action} xmlns:u="urn:Belkin:service:basicevent:1">${body}</u:${action}></s:Body>
</s:Envelope>`;
  }
  async function soapCall(action, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": 'text/xml; charset="utf-8"', SOAPACTION: `"urn:Belkin:service:basicevent:1#${action}"` },
      body: envelope(action, body),
    });
    return res.text();
  }

  async function refresh() {
    try {
      const xml = await soapCall("GetBinaryState", "");
      const match = /<BinaryState>(\d)<\/BinaryState>/.exec(xml);
      if (match) ctx.setState("device.on", match[1] === "1");
    } catch (err) {
      ctx.log(`refresh failed: ${err.message}`);
    }
  }

  ctx.onAction("turnOn", async () => {
    try {
      await soapCall("SetBinaryState", "<BinaryState>1</BinaryState>");
      ctx.setState("device.on", true);
    } catch (err) {
      ctx.log(`turnOn failed: ${err.message}`);
    }
  });
  ctx.onAction("turnOff", async () => {
    try {
      await soapCall("SetBinaryState", "<BinaryState>0</BinaryState>");
      ctx.setState("device.on", false);
    } catch (err) {
      ctx.log(`turnOff failed: ${err.message}`);
    }
  });
  ctx.onAction("refresh", () => refresh());

  return {
    onConnect() {
      refresh();
    },
    onDisconnect() {},
  };
}

module.exports = { create };
