"use strict";
// Vizio SmartCast TV driver over its local HTTPS API - not officially
// published by Vizio, but well documented via the pyvizio community
// library, moderate confidence. Uses a self-signed-cert HTTPS endpoint
// (own https.Agent with rejectUnauthorized scoped to just this driver's
// requests, same pattern as ../tesla-powerwall) and a pairing flow: the
// TV displays an on-screen 4-digit PIN, which completePairing exchanges
// for a persistent auth token. Remote button presses use Vizio's generic
// numeric "codeset/code" key system rather than named keys - the
// power/volume/mute codes below are the well-documented common ones.
const https = require("https");

const agent = new https.Agent({ rejectUnauthorized: false });
function httpsRequest(url, opts) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { agent, method: (opts && opts.method) || "GET", headers: (opts && opts.headers) || {} }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    if (opts && opts.body) req.write(opts.body);
    req.end();
  });
}

function create(ctx) {
  const host = ctx.config.connection.host;
  const port = ctx.config.connection.port || 7345;
  const base = `https://${host}:${port}`;

  function authHeaders() {
    return ctx.config.settings.authToken ? { AUTH: ctx.config.settings.authToken } : {};
  }

  ctx.onAction("startPairing", async () => {
    try {
      const res = await httpsRequest(`${base}/pairing/start`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ DEVICE_NAME: "Oak", DEVICE_ID: "oak-orchestrator" }),
      });
      const data = JSON.parse(res.body);
      const pairingToken = data.ITEM && data.ITEM.PAIRING_REQ_TOKEN;
      if (pairingToken !== undefined) {
        ctx.log(`Pairing started - PIN should now be on screen. Token: ${pairingToken}`);
      }
      ctx.emitEvent("pairingStarted", {});
    } catch (err) {
      ctx.log(`startPairing failed: ${err.message}`);
    }
  });

  ctx.onAction("completePairing", async ({ pin }) => {
    try {
      const res = await httpsRequest(`${base}/pairing/pair`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          DEVICE_ID: "oak-orchestrator",
          CHALLENGE_TYPE: 1,
          RESPONSE_VALUE: pin,
          PAIRING_REQ_TOKEN: Number(ctx.config.settings.pairingToken) || 0,
        }),
      });
      const data = JSON.parse(res.body);
      const token = data.ITEM && data.ITEM.AUTH_TOKEN;
      if (token) ctx.log(`Paired. Copy this into the authToken setting: ${token}`);
      else ctx.log(`Pairing not confirmed: ${res.body}`);
    } catch (err) {
      ctx.log(`completePairing failed: ${err.message}`);
    }
  });

  async function keyPress(codeset, code) {
    try {
      await httpsRequest(`${base}/key_command/`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ KEYLIST: [{ CODESET: codeset, CODE: code, ACTION: "KEYPRESS" }] }),
      });
    } catch (err) {
      ctx.log(`Key press failed: ${err.message}`);
    }
  }
  ctx.onAction("togglePower", () => keyPress(11, 1));
  ctx.onAction("volumeUp", () => keyPress(5, 1));
  ctx.onAction("volumeDown", () => keyPress(5, 0));
  ctx.onAction("mute", () => keyPress(5, 2));

  return {
    onConnect() {},
    onDisconnect() {},
  };
}

module.exports = { create };
