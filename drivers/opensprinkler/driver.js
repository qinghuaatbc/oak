"use strict";
// OpenSprinkler driver over its official local HTTP API - VERY HIGH
// confidence: endpoints and parameters read directly from OpenSprinkler's
// own current firmware API documentation (opensprinkler.github.io), a
// genuinely open project, not reverse-engineered.
const crypto = require("crypto");

function create(ctx) {
  function pw() {
    return crypto.createHash("md5").update(ctx.config.settings.password || "").digest("hex");
  }
  function apiUrl(path, params) {
    const qs = new URLSearchParams({ pw: pw(), ...params }).toString();
    return `http://${ctx.config.connection.host}${path}?${qs}`;
  }

  ctx.onAction("startZone", async ({ station, seconds = 300 }) => {
    try {
      await fetch(apiUrl("/cm", { sid: station, en: 1, t: seconds }));
    } catch (err) {
      ctx.log(`startZone failed: ${err.message}`);
    }
  });
  ctx.onAction("stopZone", async ({ station }) => {
    try {
      await fetch(apiUrl("/cm", { sid: station, en: 0 }));
    } catch (err) {
      ctx.log(`stopZone failed: ${err.message}`);
    }
  });
  ctx.onAction("setRainDelay", async ({ hours }) => {
    try {
      await fetch(apiUrl("/cv", { rd: hours }));
    } catch (err) {
      ctx.log(`setRainDelay failed: ${err.message}`);
    }
  });

  async function refresh() {
    try {
      const res = await fetch(apiUrl("/js", {}));
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.sn)) {
        const bitmask = data.sn.reduce((acc, bit, i) => acc | (bit ? 1 << i : 0), 0);
        ctx.setState("stationBitmask", bitmask);
      }
    } catch (err) {
      ctx.log(`Refresh failed: ${err.message}`);
    }
  }
  ctx.onAction("refresh", refresh);

  let pollTimer = null;

  return {
    onConnect() {
      refresh();
      pollTimer = ctx.clock.every(30000, refresh);
    },
    onDisconnect() {
      if (pollTimer) pollTimer.cancel();
    },
  };
}

module.exports = { create };
