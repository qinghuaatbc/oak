"use strict";
// Neato robot vacuum driver over their UNOFFICIAL cloud API (documented
// by the pybotvac community library) - same fragile class as
// ../ring/../myq/../simplisafe. Two separate hosts: beehive.neatocloud.com
// for account/auth, nucleo.neatocloud.com for actually messaging a robot.
const AUTH_URL = "https://beehive.neatocloud.com";
const ROBOT_URL = "https://nucleo.neatocloud.com";

function create(ctx) {
  let token = null;

  ctx.onAction("login", async () => {
    try {
      const res = await fetch(`${AUTH_URL}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: ctx.config.settings.email, password: ctx.config.settings.password, platform: "ios" }),
      });
      const data = await res.json();
      token = data.access_token;
      if (token) ctx.log("Logged in");
      else ctx.log(`Login failed: ${JSON.stringify(data)}`);
    } catch (err) {
      ctx.log(`Login failed: ${err.message}`);
    }
  });

  async function sendCommand(cmd, params) {
    if (!token) {
      ctx.log("Not logged in - run login first");
      return;
    }
    const serial = ctx.config.settings.serial;
    try {
      await fetch(`${ROBOT_URL}/vendors/neato/robots/${serial}/messages`, {
        method: "POST",
        headers: { Authorization: `Token token=${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ reqId: "1", cmd, params: params || {} }),
      });
    } catch (err) {
      ctx.log(`${cmd} failed: ${err.message}`);
    }
  }
  ctx.onAction("startCleaning", () => sendCommand("startCleaning", { category: 2, mode: 2, modifier: 1 }));
  ctx.onAction("stopCleaning", () => sendCommand("stopCleaning"));
  ctx.onAction("sendToBase", () => sendCommand("sendToBase"));

  ctx.onAction("discoverRobots", async () => {
    if (!token) {
      ctx.log("Not logged in - run login first");
      return;
    }
    try {
      const data = await fetch(`${AUTH_URL}/users/me/robots`, { headers: { Authorization: `Token token=${token}` } }).then((r) => r.json());
      const robots = (data || []).map((r) => ({ serial: r.serial, name: r.name }));
      ctx.setState("discovery.robots", JSON.stringify(robots));
    } catch (err) {
      ctx.log(`discoverRobots failed: ${err.message}`);
    }
  });

  return {
    onConnect() {},
    onDisconnect() {},
  };
}

module.exports = { create };
