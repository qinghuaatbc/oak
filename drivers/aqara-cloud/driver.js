"use strict";
// Aqara Open Platform driver over their own published API
// (opendoc.aqara.com) - Aqara DOES publish an official developer API
// (this is not reverse-engineered), but this driver's confidence is
// LOWER than most "official API" drivers in this project: the request-
// signing scheme (Appid/Keyid/Nonce/Time headers + an MD5 Sign) is
// recalled only approximately, and Aqara's Open Platform is documented
// primarily in Chinese with less community-library cross-verification
// than Tuya/SwitchBot's equivalent schemes. Treat the sign() function
// below as the first thing to verify against Aqara's actual docs or a
// real API response before trusting this.
//
// Also worth knowing: most Aqara devices are already reachable through
// Zigbee2MQTT or Home Assistant's own Aqara support (see ../zigbee2mqtt
// and ../homeassistant) without needing Aqara's cloud at all - this
// driver exists for the cases those don't cover (cloud-only automations,
// or a hub not paired to a local Zigbee coordinator).
const crypto = require("crypto");
const API_BASE = "https://open-cn.aqara.com/v3.0/open/api";

function sign(settings, nonce, time) {
  const { appId, keyId, appKey, accessToken } = settings;
  const parts = [`Accesstoken=${accessToken || ""}`, `Appid=${appId}`, `Keyid=${keyId}`, `Nonce=${nonce}`, `Time=${time}`];
  return crypto.createHash("md5").update(parts.join("&").toLowerCase() + appKey).digest("hex");
}

function create(ctx) {
  async function call(intent, data) {
    const settings = ctx.config.settings;
    const nonce = crypto.randomBytes(8).toString("hex");
    const time = Date.now().toString();
    const headers = {
      "Content-Type": "application/json",
      Appid: settings.appId,
      Keyid: settings.keyId,
      Nonce: nonce,
      Time: time,
      Sign: sign(settings, nonce, time),
      Accesstoken: settings.accessToken || "",
    };
    const res = await fetch(API_BASE, { method: "POST", headers, body: JSON.stringify({ intent, data }) });
    const body = await res.json();
    if (body.code !== 0) throw new Error(body.message || `Aqara API error ${body.code}`);
    return body.result;
  }

  ctx.onAction("turnOn", async () => {
    try {
      await call("config.resource.set", { subjectId: ctx.config.settings.subjectId, resources: [{ resourceId: "4.1.85", value: "1" }] });
      ctx.setState("device.on", true);
    } catch (err) {
      ctx.log(`turnOn failed: ${err.message}`);
    }
  });
  ctx.onAction("turnOff", async () => {
    try {
      await call("config.resource.set", { subjectId: ctx.config.settings.subjectId, resources: [{ resourceId: "4.1.85", value: "0" }] });
      ctx.setState("device.on", false);
    } catch (err) {
      ctx.log(`turnOff failed: ${err.message}`);
    }
  });
  ctx.onAction("setResource", async ({ resourceId, value }) => {
    try {
      await call("config.resource.set", { subjectId: ctx.config.settings.subjectId, resources: [{ resourceId, value }] });
    } catch (err) {
      ctx.log(`setResource failed: ${err.message}`);
    }
  });

  return {
    onConnect() {},
    onDisconnect() {},
  };
}

module.exports = { create };
