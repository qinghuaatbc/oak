"use strict";
// MyQ garage door driver over Chamberlain/LiftMaster's UNOFFICIAL private
// API - like ../ring/driver.js, this is the least reliable class of
// driver in this project, arguably more so than Ring: MyQ has actively
// and repeatedly changed this API specifically to break third-party
// clients (pymyq, homebridge-myq and others have all hit breaking changes
// more than once), not merely left it undocumented. The login flow below
// (POST /login with a static "MyQApplicationId" header mimicking the
// official app) matches how community projects have worked around this
// historically, but there is real, above-average risk this is already
// out of date. If this driver stops working, that's the expected
// lifecycle of depending on an API its own vendor is actively hostile
// to, not necessarily a bug here.
const API_BASE = "https://api.myqdevice.com/api/v5.1";
const APP_ID = "JVM/G9Nwih5BwKgNCjLxiFUQxQijAebyyg8QUHr7JOrP+tuPb8iHfRHKwTmDzHOu";
const POLL_MS = 60000;

function create(ctx) {
  let securityToken = null;
  let accountId = null;
  let pollHandle = null;

  function headers(extra) {
    return { "Content-Type": "application/json", MyQApplicationId: APP_ID, ...(securityToken ? { SecurityToken: securityToken } : {}), ...extra };
  }

  ctx.onAction("login", async () => {
    try {
      const res = await fetch(`${API_BASE}/login`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ username: ctx.config.settings.email, password: ctx.config.settings.password }),
      });
      const data = await res.json();
      if (!res.ok || !data.SecurityToken) {
        ctx.log(`Login failed: ${JSON.stringify(data)}`);
        return;
      }
      securityToken = data.SecurityToken;
      const accounts = await fetch(`${API_BASE}/accounts`, { headers: headers() }).then((r) => r.json());
      accountId = accounts.Accounts && accounts.Accounts[0] && accounts.Accounts[0].Id;
      ctx.log("Logged in");
    } catch (err) {
      ctx.log(`Login failed: ${err.message}`);
    }
  });

  async function doorAction(action) {
    if (!securityToken || !accountId) {
      ctx.log("Not logged in - run login first");
      return;
    }
    const deviceId = ctx.config.settings.deviceId;
    try {
      await fetch(`${API_BASE}/accounts/${accountId}/devices/${deviceId}/actions`, {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ action_type: action }),
      });
    } catch (err) {
      ctx.log(`${action} failed: ${err.message}`);
    }
  }
  ctx.onAction("open", () => doorAction("open"));
  ctx.onAction("close", () => doorAction("close"));

  async function refresh() {
    if (!securityToken || !accountId) return;
    try {
      const data = await fetch(`${API_BASE}/accounts/${accountId}/devices`, { headers: headers() }).then((r) => r.json());
      const deviceId = ctx.config.settings.deviceId;
      const device = (data.items || []).find((d) => d.serial_number === deviceId || d.device_id === deviceId);
      if (device && device.state) ctx.setState("door.state", device.state.door_state);
    } catch (err) {
      ctx.log(`Refresh failed: ${err.message}`);
    }
  }
  ctx.onAction("refresh", () => refresh());
  ctx.onAction("discoverDevices", async () => {
    if (!securityToken || !accountId) {
      ctx.log("Not logged in - run login first");
      return;
    }
    try {
      const data = await fetch(`${API_BASE}/accounts/${accountId}/devices`, { headers: headers() }).then((r) => r.json());
      const devices = (data.items || [])
        .filter((d) => d.device_family === "garagedoor")
        .map((d) => ({ id: d.serial_number, name: d.name }));
      ctx.setState("discovery.devices", JSON.stringify(devices));
    } catch (err) {
      ctx.log(`Discovery failed: ${err.message}`);
    }
  });

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
