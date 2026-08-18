"use strict";
// Bose SoundTouch driver over its own local XML/HTTP API - one of the
// most thoroughly documented smart-speaker local APIs around (Bose
// shipped an actual developer SDK for this product line historically),
// high confidence. Key presses are simulated via a press-then-release
// pair (POWER, PLAY, PAUSE, MUTE, ...), matching how the real app/remote
// interacts with the speaker.
const POLL_MS = 15000;

function create(ctx) {
  const host = ctx.config.connection.host;
  const port = ctx.config.connection.port || 8090;
  const base = `http://${host}:${port}`;

  let pollHandle = null;

  async function pressKey(key) {
    try {
      await fetch(`${base}/key`, { method: "POST", body: `<key state="press" sender="Gabbo">${key}</key>` });
      await fetch(`${base}/key`, { method: "POST", body: `<key state="release" sender="Gabbo">${key}</key>` });
      refresh();
    } catch (err) {
      ctx.log(`${key} failed: ${err.message}`);
    }
  }
  ctx.onAction("turnOn", () => pressKey("POWER"));
  ctx.onAction("play", () => pressKey("PLAY"));
  ctx.onAction("pause", () => pressKey("PAUSE"));
  ctx.onAction("mute", () => pressKey("MUTE"));
  ctx.onAction("selectPreset", ({ number }) => pressKey(`PRESET_${Math.max(1, Math.min(6, Math.round(number)))}`));

  ctx.onAction("setVolume", async ({ value }) => {
    try {
      await fetch(`${base}/volume`, { method: "POST", body: `<volume>${Math.max(0, Math.min(100, Math.round(value)))}</volume>` });
      refresh();
    } catch (err) {
      ctx.log(`setVolume failed: ${err.message}`);
    }
  });

  function extractTag(xml, tag) {
    const m = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`).exec(xml);
    return m ? m[1] : undefined;
  }
  async function refresh() {
    try {
      const nowPlaying = await fetch(`${base}/now_playing`).then((r) => r.text());
      const state = /source="([^"]*)"/.exec(nowPlaying);
      const playStatus = extractTag(nowPlaying, "playStatus");
      if (playStatus) ctx.setState("player.state", playStatus);
      else if (state) ctx.setState("player.state", state[1]);
      const volumeXml = await fetch(`${base}/volume`).then((r) => r.text());
      const actual = extractTag(volumeXml, "actualvolume");
      if (actual !== undefined) ctx.setState("player.volume", Number(actual));
    } catch (err) {
      ctx.log(`Refresh failed: ${err.message}`);
    }
  }
  ctx.onAction("refresh", () => refresh());

  return {
    onConnect() {
      refresh();
      pollHandle = ctx.clock.every(POLL_MS, refresh);
    },
    onDisconnect() {
      if (pollHandle) pollHandle.cancel();
    },
  };
}

module.exports = { create };
