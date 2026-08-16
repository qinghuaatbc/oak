"use strict";
// UniFi Protect driver over the local UniFi OS console REST API
// (proxy/protect/api/*, API-key auth via the X-API-KEY header - the
// modern, officially-documented integration path as of UniFi OS's
// Integrations settings page, not a reverse-engineered private API).
//
// Motion/ring detection is POLLING-based (diffing each camera's
// lastMotion/lastRing timestamp on a fixed interval), not the push
// WebSocket UniFi Protect's own web app uses - that update stream has an
// unusual two-frame (binary action-header + JSON payload) framing this
// driver does not have high enough confidence to reimplement correctly
// without a real controller to verify against, so it's deliberately out
// of scope rather than guessed at. Polling means motion/ring events lag
// real time by up to POLL_MS - stated as a known tradeoff, not a bug.
// Camera RTSP streaming itself is already covered by Oak's own camera
// feature (add the camera's RTSP(S) URL directly there) - this driver is
// for Protect-specific control/events, not video.
const POLL_MS = 10000;

function create(ctx) {
  const host = ctx.config.connection.host;
  const apiKey = ctx.config.settings.apiKey || "";
  const base = `https://${host}/proxy/protect/api`;

  let pollHandle = null;
  let lastMotionAt = new Map();
  let lastRingAt = new Map();

  async function apiFetch(path, opts) {
    const res = await fetch(`${base}${path}`, {
      ...opts,
      headers: { "X-API-KEY": apiKey, "Content-Type": "application/json", ...(opts && opts.headers) },
      // A UniFi OS console's local cert is normally self-signed - Node's
      // fetch has no per-request TLS-verify override, so this driver
      // relies on NODE_TLS_REJECT_UNAUTHORIZED being handled at the
      // orchestrator/deployment level for this host, same constraint any
      // local-HTTPS-only device driver here has.
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.status === 204 ? null : res.json();
  }

  async function poll() {
    const cameraId = ctx.config.settings.cameraId;
    if (!cameraId || !apiKey) return;
    try {
      const camera = await apiFetch(`/cameras/${cameraId}`);
      if (camera.lastMotion && camera.lastMotion !== lastMotionAt.get(cameraId)) {
        lastMotionAt.set(cameraId, camera.lastMotion);
        ctx.emitEvent("motion", { cameraId });
      }
      if (camera.lastRing && camera.lastRing !== lastRingAt.get(cameraId)) {
        lastRingAt.set(cameraId, camera.lastRing);
        ctx.emitEvent("ring", { cameraId });
      }
      if (camera.recordingSettings) ctx.setState("camera.recordingMode", camera.recordingSettings.mode);
    } catch (err) {
      ctx.log(`Poll failed: ${err.message}`);
    }
  }

  ctx.onAction("discoverCameras", async () => {
    try {
      const bootstrap = await apiFetch("/bootstrap");
      const cameras = (bootstrap.cameras || []).map((c) => ({ id: c.id, name: c.name, type: c.type }));
      ctx.setState("discovery.cameras", JSON.stringify(cameras));
    } catch (err) {
      ctx.log(`Discovery failed: ${err.message}`);
    }
  });
  ctx.onAction("setRecordingMode", async ({ mode }) => {
    const cameraId = ctx.config.settings.cameraId;
    try {
      await apiFetch(`/cameras/${cameraId}`, { method: "PATCH", body: JSON.stringify({ recordingSettings: { mode } }) });
    } catch (err) {
      ctx.log(`setRecordingMode failed: ${err.message}`);
    }
  });
  ctx.onAction("playChime", async () => {
    const cameraId = ctx.config.settings.cameraId;
    try {
      await apiFetch(`/cameras/${cameraId}/talkback-session`, { method: "POST", body: JSON.stringify({}) });
    } catch (err) {
      ctx.log(`playChime failed: ${err.message}`);
    }
  });
  ctx.onAction("setStatusLight", async ({ on }) => {
    const cameraId = ctx.config.settings.cameraId;
    try {
      await apiFetch(`/cameras/${cameraId}`, { method: "PATCH", body: JSON.stringify({ ledSettings: { isEnabled: Boolean(on) } }) });
    } catch (err) {
      ctx.log(`setStatusLight failed: ${err.message}`);
    }
  });

  return {
    onConnect() {
      poll();
      pollHandle = ctx.clock.every(POLL_MS, poll);
    },
    onDisconnect() {
      if (pollHandle) pollHandle.cancel();
    },
  };
}

module.exports = { create };
