"use strict";
// Konnected alarm-panel-interface driver over their own local HTTP API
// (konnected.io publishes API docs for their alarm panel wiring
// interface board) - real, documented, moderate-high confidence on the
// control endpoint.
//
// SCOPE NOTE: Konnected reports zone/sensor state changes via an
// OUTBOUND webhook POST to a URL you configure on the device, not a
// pollable status endpoint - Oak's driver model has no way to expose a
// per-driver listening endpoint for a third-party device to push into
// (only the orchestrator's own single HTTP server exists), so that push
// path is out of scope here. This driver is control-only (triggering an
// output pin/zone), not state-reporting.
function create(ctx) {
  const host = ctx.config.connection.host;
  const port = ctx.config.connection.port || 12345;
  const base = `http://${host}:${port}`;

  async function setOutput(state) {
    try {
      await fetch(`${base}/device`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: ctx.config.settings.pin, state }) });
    } catch (err) {
      ctx.log(`Command failed: ${err.message}`);
    }
  }
  ctx.onAction("setOutputOn", () => setOutput(1));
  ctx.onAction("setOutputOff", () => setOutput(0));

  return {
    onConnect() {},
    onDisconnect() {},
  };
}

module.exports = { create };
