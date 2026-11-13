// Ported from QTI's shared.js attachCameraPlayer: RTSP -> ffmpeg (server,
// see server.js's startCameraFfmpeg) -> fragmented MP4 over a raw binary
// WebSocket -> MediaSource here -> <video>. No browser plugin - MSE
// decodes H.264 natively.
//
// In the Oak desktop client the page is the same, but the client plays the
// cameras itself: it sets window.oakCameraService to its own local service,
// which reads the camera directly and sends its H.264 or H.265 as it is (no
// transcoding, nothing through the server), saying first which codec:
// {"type":"codec","mime":"video/mp4; codecs=\"hvc1...\""}.
import { BASE } from "./base.js";

const CAMERA_CODEC_CANDIDATES = [
  'video/mp4; codecs="avc1.640028"',
  'video/mp4; codecs="avc1.4d0028"',
  'video/mp4; codecs="avc1.42e01e"',
];

// iOS/iPadOS Safari has no global MediaSource - only ManagedMediaSource
// (iOS 17.1+). Every other browser (desktop Safari included) has plain
// MediaSource. Without this fallback, `new MediaSource()` throws
// immediately on iPhone and the camera tile just never lights up.
const MediaSourceCtor = window.ManagedMediaSource || window.MediaSource;

export function attachCameraPlayer(videoEl, rtspUrl) {
  let ws = null;
  let mediaSource = null;
  let sourceBuffer = null;
  const pendingChunks = [];
  let stopped = false;

  function pickMimeType() {
    return CAMERA_CODEC_CANDIDATES.find((t) => MediaSourceCtor.isTypeSupported(t)) || CAMERA_CODEC_CANDIDATES[0];
  }

  function pumpQueue() {
    if (!sourceBuffer || sourceBuffer.updating || !pendingChunks.length) return;
    try {
      sourceBuffer.appendBuffer(pendingChunks.shift());
    } catch (e) {
      pendingChunks.shift(); // SourceBuffer in a bad state - drop this chunk, next one may recover it
    }
  }

  function connect() {
    if (!MediaSourceCtor) {
      console.error("camera stream: no MediaSource/ManagedMediaSource support in this browser");
      return;
    }
    if (videoEl.src) URL.revokeObjectURL(videoEl.src);
    pendingChunks.length = 0;
    sourceBuffer = null;
    if (window.ManagedMediaSource) videoEl.disableRemotePlayback = true;
    mediaSource = new MediaSourceCtor();
    videoEl.src = URL.createObjectURL(mediaSource);
    mediaSource.addEventListener("sourceopen", () => {
      if (stopped) return;
      // (Made once the type is known: named by the stream, else the H.264 guess.)
      const openBuffer = (mime) => {
        sourceBuffer = mediaSource.addSourceBuffer(mime);
        sourceBuffer.addEventListener("updateend", pumpQueue);
      };
      const base = window.oakCameraService || `${location.protocol === "https:" ? "wss://" : "ws://"}${location.host}${BASE}`;
      ws = new WebSocket(`${base}/camera-ws?url=${encodeURIComponent(rtspUrl)}`);
      ws.binaryType = "arraybuffer";
      ws.addEventListener("message", (ev) => {
        if (typeof ev.data === "string") {
          let msg = null;
          try {
            msg = JSON.parse(ev.data);
          } catch (e) {}
          if (msg && msg.type === "codec" && !sourceBuffer) {
            try {
              openBuffer(msg.mime);
            } catch (e) {
              console.error("camera stream: this browser can't play", msg.mime);
            }
            return;
          }
          console.error("camera stream error:", ev.data);
          return;
        }
        if (!sourceBuffer) openBuffer(pickMimeType());
        pendingChunks.push(new Uint8Array(ev.data));
        pumpQueue();
      });
      ws.addEventListener("close", () => {
        if (!stopped) setTimeout(connect, 3000);
      });
    });
  }

  function stop() {
    stopped = true;
    if (ws) ws.close();
    if (videoEl.src) {
      URL.revokeObjectURL(videoEl.src);
      videoEl.removeAttribute("src");
    }
  }

  connect();
  return { stop };
}
