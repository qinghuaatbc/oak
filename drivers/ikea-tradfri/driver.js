"use strict";
// IKEA Trådfri driver over the gateway's CoAP+DTLS API, using the
// `node-coap-client` package (a real npm dependency added to this
// project specifically for this driver - DTLS has no Node core module,
// and hand-rolling DTLS 1.2 correctly is a genuinely large crypto-
// protocol undertaking this project chose to depend on a vetted library
// for instead, the same judgment call already reflected in this repo's
// existing `ws`/`web-push` dependencies rather than hand-rolling
// WebSocket/VAPID crypto). CoapClient's actual API (setSecurityParams/
// request/observe signatures) was read directly from the installed
// package's README/type declarations, not recalled from memory - see
// node_modules/node-coap-client/README.md.
//
// The PSK-minting exchange itself (POST security code -> get a
// persistent client identity+key) is IKEA's own documented Trådfri
// gateway behavior, reimplemented here directly since this project uses
// node-coap-client (the lower-level CoAP+DTLS layer) rather than
// node-tradfri-client (which wraps that exchange but is a bigger, more
// opinionated dependency this driver doesn't need). Endpoint paths/keys
// (15001=devices, 3311=lightbulb resource, 5850=on/off, 5851=dimmer) are
// IKEA's own well-documented (via node-tradfri-client/ioBroker) gateway
// vocabulary. Not verified against a real gateway this session - treat
// as a plausible starting point, same disclaimer as any first-draft
// driver.
const { CoapClient } = require("node-coap-client");

function create(ctx) {
  const host = ctx.config.connection.host;
  const gatewayUrl = `coaps://${host}:5684`;
  let observing = false;

  function deviceUrl() {
    return `${gatewayUrl}/15001/${ctx.config.settings.deviceId}`;
  }

  ctx.onAction("authenticate", async () => {
    const code = ctx.config.settings.securityCode;
    if (!code) {
      ctx.log("Set the securityCode setting first (printed on the gateway's underside)");
      return;
    }
    const identity = `oak-${Date.now()}`;
    CoapClient.setSecurityParams(host, { psk: { Client_identity: code } });
    try {
      const res = await CoapClient.request(`${gatewayUrl}/15011/9063`, "post", Buffer.from(JSON.stringify({ 9090: identity })));
      const body = JSON.parse(res.payload.toString("utf8"));
      const psk = body["9091"];
      ctx.log(`Authenticated. Copy these into settings: identity="${identity}" psk="${psk}"`);
      ctx.emitEvent("authenticated", { identity });
      // Switch to the freshly-minted credentials for the rest of this
      // session immediately, rather than waiting for a restart with the
      // settings saved - a real reconnect still needs those settings
      // saved for next time, though (nothing here persists to disk).
      CoapClient.reset(host);
      CoapClient.setSecurityParams(host, { psk: { [identity]: psk } });
    } catch (err) {
      ctx.log(`Authentication failed: ${err.message || err}`);
    }
  });

  function applyState(payload) {
    const light = (payload["3311"] || [])[0];
    if (!light) return;
    const on = light["5850"] === 1;
    const brightness = light["5851"] !== undefined ? Math.round((light["5851"] / 254) * 100) : undefined;
    ctx.setState("device.on", on);
    if (brightness !== undefined) ctx.setState("device.brightness", brightness);
    ctx.emitEvent("stateChanged", { on, brightness });
  }

  async function putLight(fields) {
    try {
      await CoapClient.request(deviceUrl(), "put", Buffer.from(JSON.stringify({ 3311: [fields] })));
    } catch (err) {
      ctx.log(`Command failed: ${err.message || err}`);
    }
  }

  ctx.onAction("turnOn", () => putLight({ 5850: 1 }));
  ctx.onAction("turnOff", () => putLight({ 5850: 0 }));
  ctx.onAction("setBrightness", ({ value }) => putLight({ 5850: 1, 5851: Math.round((Math.max(0, Math.min(100, value)) / 100) * 254) }));

  return {
    async onConnect() {
      const identity = ctx.config.settings.identity;
      const psk = ctx.config.settings.psk;
      if (!identity || !psk) {
        ctx.log("Not authenticated yet - run the Authenticate action first, then save identity/psk into settings");
        return;
      }
      CoapClient.setSecurityParams(host, { psk: { [identity]: psk } });
      if (!ctx.config.settings.deviceId) return;
      try {
        await CoapClient.observe(deviceUrl(), "get", (resp) => {
          try {
            applyState(JSON.parse(resp.payload.toString("utf8")));
          } catch (err) {
            ctx.log(`Failed to parse device state: ${err.message}`);
          }
        });
        observing = true;
      } catch (err) {
        ctx.log(`Failed to observe device: ${err.message || err}`);
      }
    },
    onDisconnect() {
      if (observing) CoapClient.stopObserving(deviceUrl());
      CoapClient.reset(host);
      observing = false;
    },
  };
}

module.exports = { create };
