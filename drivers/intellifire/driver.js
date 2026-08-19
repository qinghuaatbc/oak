"use strict";
// IntelliFire (Hearth & Home Technologies) gas fireplace driver -
// EXPLICITLY UNOFFICIAL: Hearth & Home has no public API documentation.
// Verified against the CURRENT SOURCE of jeeftor/intellifire4py (the
// library behind Home Assistant's official IntelliFire integration),
// not just its README - the challenge-response double-SHA256 algorithm
// and local command names below are read directly from that library's
// local_api.py. HIGH confidence this matches how the library/HA
// integration works today, but this is a reverse-engineered surface
// that could change without notice, same caveat as this project's other
// unofficial cloud drivers (ring, simplisafe, genie-aladdin).
//
// Two-stage design, matching the real system: a one-time cloud login
// (email/password) fetches this fireplace's api_key/user_id (tied to its
// serial number), then all polling/control happens over the LOCAL HTTP
// API - avoiding a cloud round-trip for every command once the key is
// cached for the life of this driver instance.
const crypto = require("crypto");
const CLOUD_BASE = "https://iftapi.net/a";

function create(ctx) {
  let apiKey = null;
  let userId = null;
  let cookie = null;

  function hostUrl(path) {
    return `http://${ctx.config.connection.host}${path}`;
  }

  async function cloudLogin() {
    const { email, password } = ctx.config.settings;
    const res = await fetch(`${CLOUD_BASE}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: email || "", password: password || "" }).toString(),
    });
    const setCookie = res.headers.get("set-cookie");
    if (!res.ok || !setCookie) return false;
    cookie = setCookie.split(";")[0];
    return true;
  }

  async function fetchControlKey() {
    const serial = ctx.config.settings.serial;
    const locRes = await fetch(`${CLOUD_BASE}/enumlocations`, { headers: { Cookie: cookie } });
    const locations = await locRes.json();
    const list = Array.isArray(locations) ? locations : locations.locations || [];
    for (const loc of list) {
      const fpRes = await fetch(`${CLOUD_BASE}/enumfireplaces?location_id=${loc.location_id}`, { headers: { Cookie: cookie } });
      const fireplaces = await fpRes.json();
      const fpList = Array.isArray(fireplaces) ? fireplaces : fireplaces.fireplaces || [];
      const match = fpList.find((f) => f.serial === serial);
      if (match) {
        apiKey = match.api_key;
        userId = match.user_id;
        return true;
      }
    }
    return false;
  }

  async function sendLocalCommand(command, value) {
    try {
      if (!apiKey && !((cookie || (await cloudLogin())) && (await fetchControlKey()))) {
        ctx.log("Could not resolve fireplace control key - check email/password/serial");
        return;
      }
      const challengeRes = await fetch(hostUrl("/get_challenge"));
      const challenge = (await challengeRes.text()).trim();
      const payload = Buffer.from(`post:command=${command}&value=${value}`, "utf8");
      const apiKeyBytes = Buffer.from(apiKey, "hex");
      const challengeBytes = Buffer.from(challenge, "hex");
      const inner = crypto.createHash("sha256").update(Buffer.concat([apiKeyBytes, challengeBytes, payload])).digest();
      const response = crypto.createHash("sha256").update(Buffer.concat([apiKeyBytes, inner])).digest("hex");
      await fetch(hostUrl("/post"), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `command=${command}&value=${value}&user=${userId}&response=${response}`,
      });
    } catch (err) {
      ctx.log(`${command} failed: ${err.message}`);
    }
  }

  ctx.onAction("powerOn", () => sendLocalCommand("power", 1));
  ctx.onAction("powerOff", () => sendLocalCommand("power", 0));
  ctx.onAction("setFlameHeight", ({ height }) => sendLocalCommand("flame_height", height));
  ctx.onAction("setFanSpeed", ({ speed }) => sendLocalCommand("fan_speed", speed));

  async function refresh() {
    try {
      const res = await fetch(hostUrl("/poll"));
      if (!res.ok) return;
      const data = await res.json();
      ctx.setState("status.raw", JSON.stringify(data));
    } catch (err) {
      ctx.log(`Refresh failed: ${err.message}`);
    }
  }

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
