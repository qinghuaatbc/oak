"use strict";
// Cameras: the saved list (/api/cameras) and the ffmpeg process that turns
// one camera's RTSP stream into fragmented MP4 for a /camera-ws socket.
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { loadJsonArray, saveJsonArray, sendJson, readJsonBody } = require("./http-util");

const CAMERAS_PATH = process.env.OAK_CAMERAS || path.join(__dirname, "cameras.json");
let cameras = loadJsonArray(CAMERAS_PATH); // [{id, name, rtspUrl}]

// Ported directly from QTI's own server.js startCameraFfmpeg - the ffmpeg
// flags here (-g 16, -force_key_frames, -frag_duration) were arrived at
// against a real Hikvision camera: -movflags frag_keyframe ALONE only
// starts a new fragment at each keyframe, and that camera's substream only
// ever emitted ONE keyframe for the whole encode - nothing reached the
// client until ffmpeg exited. Forcing a keyframe every second plus
// time-based fragmentation independent of keyframes is what actually makes
// the stream arrive incrementally. Re-deriving this from scratch would mean
// re-discovering the same bug against real hardware; reusing the known-good
// flags is the point of "reference QTI" here.
const activeCameraProcs = new Set();

// ffmpeg: OAK_FFMPEG, else on the PATH, else where Homebrew and Linux put it -
// a service (launchd especially) gets a PATH without /opt/homebrew/bin, so a
// plain spawn("ffmpeg") failed there with ENOENT though ffmpeg was installed.
function ffmpegPath() {
  if (process.env.OAK_FFMPEG) return process.env.OAK_FFMPEG;
  const name = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const dirs = [...(process.env.PATH || "").split(path.delimiter), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
  for (const dir of dirs) {
    if (dir && fs.existsSync(path.join(dir, name))) return path.join(dir, name);
  }
  return name;
}

function startCameraFfmpeg(rtspUrl, ws) {
  const args = [
    "-rtsp_transport", "tcp",
    "-i", rtspUrl,
    "-an",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-tune", "zerolatency",
    "-profile:v", "high",
    "-pix_fmt", "yuv420p",
    "-g", "16",
    "-force_key_frames", "expr:gte(t,n_forced*1)",
    "-f", "mp4",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof+dash",
    "-frag_duration", "1000000",
    "-reset_timestamps", "1",
    "pipe:1",
  ];
  const proc = spawn(ffmpegPath(), args, { stdio: ["ignore", "pipe", "pipe"] });
  activeCameraProcs.add(proc);

  // An unreachable/misconfigured camera doesn't necessarily make ffmpeg
  // exit - it can sit there retrying indefinitely, burning CPU. Give it
  // CONNECT_TIMEOUT_MS to produce real output before killing it.
  const CONNECT_TIMEOUT_MS = 10000;
  let gotData = false;
  const connectTimer = setTimeout(() => {
    if (gotData) return;
    try {
      ws.send(JSON.stringify({ type: "error", error: `Camera did not respond within ${CONNECT_TIMEOUT_MS / 1000}s - check the RTSP URL/credentials.` }));
    } catch (e) {
      /* client gone */
    }
    proc.kill();
  }, CONNECT_TIMEOUT_MS);

  proc.stdout.on("data", (chunk) => {
    if (!gotData) {
      gotData = true;
      clearTimeout(connectTimer);
    }
    try {
      ws.sendBinary(chunk);
    } catch (e) {
      proc.kill();
    }
  });
  let stderrTail = "";
  proc.stderr.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4000);
  });
  proc.on("exit", (code) => {
    clearTimeout(connectTimer);
    activeCameraProcs.delete(proc);
    if (code !== 0 && code !== null) {
      try {
        ws.send(JSON.stringify({ type: "error", error: `ffmpeg exited (${code}): ${stderrTail.split("\n").slice(-5).join(" ")}` }));
      } catch (e) {
        /* client gone */
      }
    }
    try {
      ws.close();
    } catch (e) {
      /* already closed */
    }
  });
  // spawn() failing outright (ffmpeg not installed) fires an 'error' event
  // on the child process - with no listener, Node treats that as an
  // uncaught exception. The process-level net at the top of this file would
  // catch it, but a reconnecting client would then repeat that indefinitely
  // - handle it here directly instead, same as QTI's own comment on this.
  proc.on("error", (/** @type {NodeJS.ErrnoException} */ err) => {
    clearTimeout(connectTimer);
    activeCameraProcs.delete(proc);
    try {
      ws.send(JSON.stringify({ type: "error", error: `Couldn't start ffmpeg: ${err.message}${err.code === "ENOENT" ? " - is ffmpeg installed on this server?" : ""}` }));
    } catch (e) {
      /* client gone */
    }
    try {
      ws.close();
    } catch (e) {
      /* already closed */
    }
  });
  ws.on("close", () => proc.kill());
  return proc;
}

/** /api/cameras */
async function routes(req, res, parts) {
  if (parts[1] === "cameras" && parts.length === 2 && req.method === "GET") {
    return sendJson(res, 200, cameras);
  }
  if (parts[1] === "cameras" && parts.length === 2 && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      if (!body.name || !body.rtspUrl) return sendJson(res, 400, { error: "name and rtspUrl are required" });
      const camera = { id: body.id || `cam-${Date.now()}`, name: body.name, rtspUrl: body.rtspUrl };
      cameras.push(camera);
      saveJsonArray(CAMERAS_PATH, cameras);
      return sendJson(res, 200, { ok: true, id: camera.id });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }
  if (parts[1] === "cameras" && parts.length === 3 && req.method === "DELETE") {
    cameras = cameras.filter((c) => c.id !== parts[2]);
    saveJsonArray(CAMERAS_PATH, cameras);
    return sendJson(res, 200, { ok: true });
  }
  res.writeHead(404);
  res.end("Not found");
}

module.exports = { routes, startCameraFfmpeg };
