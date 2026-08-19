"use strict";
// Tesla Wall Connector (Gen 3) driver over its local, unauthenticated
// HTTP API - HIGH confidence on endpoints/fields, corroborated across
// multiple independent community integrations (evcc-io, ioBroker,
// openHAB) all converging on identical paths and field names.
//
// MONITORING ONLY, DELIBERATELY: research found no documented or
// reverse-engineered endpoint on this local API to start/stop charging
// or set a current limit on the Gen 3 unit - that capability existed on
// older Gen 2/TWCManager-era chargers via a different protocol, not this
// one. Rather than guess at a control endpoint that may not exist, this
// driver only exposes telemetry. Polls conservatively (60s) since the
// unit is documented to become unresponsive under excessive polling.
function create(ctx) {
  function apiUrl(path) {
    return `http://${ctx.config.connection.host}${path}`;
  }

  async function refresh() {
    try {
      const res = await fetch(apiUrl("/api/1/vitals"));
      if (!res.ok) return;
      const v = await res.json();
      ctx.setState("vehicleConnected", Boolean(v.vehicle_connected));
      ctx.setState("contactorClosed", Boolean(v.contactor_closed));
      ctx.setState("vehicleCurrentA", v.vehicle_current_a);
      ctx.setState("gridV", v.grid_v);
      ctx.setState("sessionEnergyWh", v.session_energy_wh);
      ctx.setState("pcbaTempC", v.pcba_temp_c);
      ctx.setState("evseState", v.evse_state);
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
