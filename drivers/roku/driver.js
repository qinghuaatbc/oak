"use strict";
// Roku driver over the device's own local External Control Protocol (ECP -
// developer.roku.com/docs/developer-program/dev-tools/external-control-api.md),
// plain HTTP on port 8060, no pairing/auth needed for basic remote-control
// commands on the same LAN. No XML parser in the driver sandbox (same
// constraint eisy/sonos already work within) - response fields come out
// via a small regex helper.
function create(ctx) {
  const host = ctx.config.connection.host;
  const port = ctx.config.connection.port || 8060;
  const baseUrl = `http://${host}:${port}`;
  let pollHandle = null;
  let lastSnapshot = null;

  function xmlAttr(xml, tag, attr) {
    const m = xml.match(new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`));
    return m ? m[1] : undefined;
  }

  async function keypress(key) {
    try {
      await fetch(`${baseUrl}/keypress/${encodeURIComponent(key)}`, { method: "POST" });
    } catch (err) {
      ctx.log(`keypress(${key}) failed:`, err.message);
    }
  }

  async function fetchStatus() {
    try {
      const res = await fetch(`${baseUrl}/query/media-player`);
      const xml = await res.text();
      const playState = xmlAttr(xml, "player", "state") || "unknown";
      if (playState === lastSnapshot) return;
      lastSnapshot = playState;
      ctx.setState("media.on", playState === "play");
      ctx.setState("media.playState", playState);
      ctx.emitEvent("stateChanged", { playState });
    } catch (err) {
      ctx.log("status poll failed:", err.message);
    }
  }

  ctx.onAction("play", () => keypress("Play").then(fetchStatus));
  ctx.onAction("pause", () => keypress("Play").then(fetchStatus)); // Roku's "Play" key toggles play/pause - there's no separate pause key in ECP
  ctx.onAction("home", () => keypress("Home"));
  ctx.onAction("back", () => keypress("Back"));
  ctx.onAction("select", () => keypress("Select"));
  ctx.onAction("up", () => keypress("Up"));
  ctx.onAction("down", () => keypress("Down"));
  ctx.onAction("left", () => keypress("Left"));
  ctx.onAction("right", () => keypress("Right"));
  ctx.onAction("volumeUp", () => keypress("VolumeUp"));
  ctx.onAction("volumeDown", () => keypress("VolumeDown"));
  ctx.onAction("mute", () => keypress("VolumeMute"));
  ctx.onAction("sendKey", ({ key }) => (key ? keypress(key) : ctx.log("sendKey: key is required")));
  ctx.onAction("launchApp", async ({ appId }) => {
    if (!appId) {
      ctx.log("launchApp: appId is required");
      return;
    }
    try {
      await fetch(`${baseUrl}/launch/${encodeURIComponent(appId)}`, { method: "POST" });
    } catch (err) {
      ctx.log("launchApp failed:", err.message);
    }
  });
  ctx.onAction("discoverApps", async () => {
    try {
      const res = await fetch(`${baseUrl}/query/apps`);
      const xml = await res.text();
      const nodes = [];
      const re = /<app id="([^"]*)"[^>]*>([^<]*)<\/app>/g;
      let m;
      while ((m = re.exec(xml))) nodes.push({ address: m[1], name: m[2] });
      ctx.setState("discovery.nodes", JSON.stringify(nodes));
      ctx.emitEvent("appsDiscovered", { count: nodes.length });
    } catch (err) {
      ctx.log("discoverApps failed:", err.message);
    }
  });

  return {
    onConnect() {
      ctx.log("Polling", baseUrl);
      fetchStatus();
      const intervalMs = (ctx.config.settings && ctx.config.settings.pollIntervalMs) || 5000;
      pollHandle = ctx.clock.every(intervalMs, fetchStatus);
    },
    onDisconnect() {
      if (pollHandle) pollHandle.cancel();
    },
  };
}
module.exports = { create };
