"use strict";
// Tesla vehicle driver over the UNOFFICIAL Owner API
// (owner-api.teslamotors.com) - Tesla has never published a public API
// for this. Like ../ring/driver.js and ../myq/driver.js, treat this as
// the least-stable class of driver here. One extra wrinkle beyond those
// two: Tesla's login (auth.tesla.com) is a captcha-protected SSO web
// form as of a few years ago, which means a simple username+password
// grant (what Ring/MyQ still use) does NOT work here anymore - this
// driver only supports the refresh-token path (obtained once via an
// external tool like the community `tesla-auth` CLI, which handles the
// interactive captcha login for you) rather than attempting a login flow
// that would just fail.
//
// Most commands need the car AWAKE first (Tesla's own API sleeps the
// vehicle to save 12V battery) - wake() polls until the vehicle reports
// "online" before returning, matching how every community Tesla library
// handles this same real hardware constraint.
const AUTH_URL = "https://auth.tesla.com/oauth2/v3/token";
const API_BASE = "https://owner-api.teslamotors.com/api/1";
const POLL_MS = 5 * 60 * 1000;

function create(ctx) {
  let accessToken = null;
  let pollHandle = null;

  async function refreshAccessToken() {
    const refreshToken = ctx.config.settings.refreshToken;
    if (!refreshToken) return false;
    const res = await fetch(AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", client_id: "ownerapi", refresh_token: refreshToken, scope: "openid email offline_access" }),
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) {
      ctx.log(`Token refresh failed: ${data.error || res.status}`);
      return false;
    }
    accessToken = data.access_token;
    return true;
  }

  async function api(path, opts) {
    if (!accessToken && !(await refreshAccessToken())) return null;
    function request() {
      return fetch(`${API_BASE}${path}`, { ...opts, headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...(opts && opts.headers) } });
    }
    let res = await request();
    if (res.status === 401 && (await refreshAccessToken())) res = await request();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function command(name, body) {
    const vehicleId = ctx.config.settings.vehicleId;
    try {
      await api(`/vehicles/${vehicleId}/command/${name}`, { method: "POST", body: body ? JSON.stringify(body) : undefined });
    } catch (err) {
      ctx.log(`${name} failed: ${err.message}`);
    }
  }

  ctx.onAction("wake", async () => {
    const vehicleId = ctx.config.settings.vehicleId;
    try {
      for (let attempt = 0; attempt < 10; attempt++) {
        const data = await api(`/vehicles/${vehicleId}/wake_up`, { method: "POST" });
        if (data && data.response && data.response.state === "online") return;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      ctx.log("Vehicle did not wake within the retry window");
    } catch (err) {
      ctx.log(`wake failed: ${err.message}`);
    }
  });
  ctx.onAction("lock", () => command("door_lock").then(refresh));
  ctx.onAction("unlock", () => command("door_unlock").then(refresh));
  ctx.onAction("startCharging", () => command("charge_start"));
  ctx.onAction("stopCharging", () => command("charge_stop"));
  ctx.onAction("setChargeLimit", ({ value }) => command("set_charge_limit", { percent: Math.max(50, Math.min(100, value)) }));
  ctx.onAction("honkHorn", () => command("honk_horn"));
  ctx.onAction("flashLights", () => command("flash_lights"));

  ctx.onAction("discoverVehicles", async () => {
    try {
      const data = await api("/vehicles");
      const vehicles = (data.response || []).map((v) => ({ id: v.id_s, name: v.display_name, vin: v.vin }));
      ctx.setState("discovery.vehicles", JSON.stringify(vehicles));
    } catch (err) {
      ctx.log(`discoverVehicles failed: ${err.message}`);
    }
  });

  async function refresh() {
    const vehicleId = ctx.config.settings.vehicleId;
    if (!vehicleId) return;
    try {
      const data = await api(`/vehicles/${vehicleId}/vehicle_data`);
      const v = data && data.response;
      if (!v) return;
      if (v.vehicle_state) ctx.setState("vehicle.locked", Boolean(v.vehicle_state.locked));
      if (v.charge_state) {
        ctx.setState("vehicle.batteryLevel", v.charge_state.battery_level);
        ctx.setState("vehicle.chargingState", v.charge_state.charging_state);
      }
    } catch (err) {
      ctx.log(`Refresh failed (vehicle may be asleep - run wake first): ${err.message}`);
    }
  }
  ctx.onAction("refresh", () => refresh());

  return {
    onConnect() {
      pollHandle = ctx.clock.every(POLL_MS, refresh);
    },
    onDisconnect() {
      if (pollHandle) pollHandle.cancel();
    },
  };
}

module.exports = { create };
