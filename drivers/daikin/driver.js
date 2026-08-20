"use strict";
// Daikin WiFi-adapter AC driver over the classic BRP069-series local HTTP
// API - VERY HIGH confidence: plain HTTP, no auth at all, query-string
// commands read directly from the pydaikin library (the library behind
// Home Assistant's own Daikin integration).
//
// SCOPE: this covers BRP069-series adapters only. Firmware >=2.8.0
// (BRP084 and newer) uses a completely different protocol
// (/dsiot/multireq with JSON bodies) - NOT covered here. If this driver
// gets no response, the target unit may be on the newer adapter and
// need a different driver entirely, not just different parameters.
//
// Daikin's API requires the FULL set of control fields on every
// set_control_info call, not just the ones being changed (confirmed in
// pydaikin's source) - this driver always reads current control info
// first and merges the requested change into it before sending, exactly
// matching that library's approach.
function parseKV(text) {
  const out = {};
  for (const pair of text.split(",")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    out[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  return out;
}

function create(ctx) {
  function apiUrl(path) {
    return `http://${ctx.config.connection.host}${path}`;
  }

  async function getControlInfo() {
    const res = await fetch(apiUrl("/aircon/get_control_info"));
    return parseKV(await res.text());
  }
  async function setControlInfo(changes) {
    const current = await getControlInfo();
    const merged = { ...current, ...changes };
    const qs = new URLSearchParams({
      pow: merged.pow, mode: merged.mode, stemp: merged.stemp, shum: merged.shum,
      f_rate: merged.f_rate, f_dir: merged.f_dir,
    }).toString();
    await fetch(apiUrl(`/aircon/set_control_info?${qs}`));
  }

  ctx.onAction("powerOn", async () => {
    try {
      await setControlInfo({ pow: "1" });
    } catch (err) {
      ctx.log(`powerOn failed: ${err.message}`);
    }
  });
  ctx.onAction("powerOff", async () => {
    try {
      await setControlInfo({ pow: "0" });
    } catch (err) {
      ctx.log(`powerOff failed: ${err.message}`);
    }
  });
  ctx.onAction("setTemperature", async ({ temp }) => {
    try {
      await setControlInfo({ stemp: String(temp) });
    } catch (err) {
      ctx.log(`setTemperature failed: ${err.message}`);
    }
  });
  ctx.onAction("setMode", async ({ mode }) => {
    try {
      await setControlInfo({ mode: String(mode) });
    } catch (err) {
      ctx.log(`setMode failed: ${err.message}`);
    }
  });

  async function refresh() {
    try {
      const info = await getControlInfo();
      ctx.setState("power", info.pow === "1");
      ctx.setState("targetTemp", Number(info.stemp));
      ctx.setState("mode", info.mode);
      const res = await fetch(apiUrl("/aircon/get_sensor_info"));
      const sensor = parseKV(await res.text());
      if (sensor.htemp !== undefined) ctx.setState("roomTemp", Number(sensor.htemp));
    } catch (err) {
      ctx.log(`Refresh failed: ${err.message}`);
    }
  }
  ctx.onAction("refresh", refresh);

  let pollTimer = null;

  return {
    onConnect() {
      refresh();
      pollTimer = ctx.clock.every(60000, refresh);
    },
    onDisconnect() {
      if (pollTimer) pollTimer.cancel();
    },
  };
}

module.exports = { create };
