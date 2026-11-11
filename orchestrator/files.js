"use strict";
// Files served to the browser: the pages in public/, uploaded 3D models
// (/models/...) and images (/images/...), and the upload routes for those.
const fs = require("fs");
const path = require("path");
const { sendJson, readJsonBody } = require("./http-util");

const MODELS_DIR = process.env.OAK_MODELS_DIR || path.join(__dirname, "models");
const IMAGES_DIR = process.env.OAK_IMAGES_DIR || path.join(__dirname, "images");
const PUBLIC_DIR = path.join(__dirname, "public");
const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".glb": "model/gltf-binary",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml",
};
if (!fs.existsSync(MODELS_DIR)) fs.mkdirSync(MODELS_DIR, { recursive: true });
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

function serveStatic(req, res) {
  let reqPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  if (reqPath === "/") reqPath = "/admin.html";
  let baseDir = PUBLIC_DIR;
  if (reqPath.startsWith("/models/")) {
    baseDir = MODELS_DIR;
    reqPath = reqPath.slice("/models".length);
  } else if (reqPath.startsWith("/images/")) {
    baseDir = IMAGES_DIR;
    reqPath = reqPath.slice("/images".length);
  }
  const filePath = path.join(baseDir, reqPath);
  if (!filePath.startsWith(baseDir)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const ext = path.extname(filePath);
    const type = STATIC_TYPES[ext] || "application/octet-stream";
    // Explicit Content-Length (not left to Node to infer) - without it,
    // this response comes back chunked with no declared size, so the
    // browser's fetch/XHR progress events report lengthComputable:false
    // for a .glb load and the admin/live 3D loading bar can only ever
    // show an indeterminate stripe, never a real percentage.
    const headers = { "Content-Type": type, "Content-Length": data.length };
    // No Cache-Control at all here previously meant every browser applied
    // its own heuristic freshness lifetime with zero way for this server
    // to force a revalidation - an edited admin.js/live.js/admin.html
    // could keep being served stale from cache indefinitely, and an iOS
    // "Add to Home Screen" PWA caches even more aggressively than a
    // regular browser tab. HTML/JS/CSS are small and change during active
    // development, so always revalidate; models/images are large and
    // effectively immutable once uploaded (a re-upload gets a new
    // filename), so those are left to the browser's own default caching.
    if (ext === ".html" || ext === ".js" || ext === ".css") headers["Cache-Control"] = "no-cache";
    res.writeHead(200, headers);
    res.end(data);
  });
}

/** /api/glb, /api/glb-upload, /api/image-upload */
async function routes(req, res, parts) {
  if (parts[1] === "glb" && parts.length === 2 && req.method === "GET") {
    const files = fs.readdirSync(MODELS_DIR).filter((f) => f.toLowerCase().endsWith(".glb"));
    return sendJson(res, 200, files.map((f) => ({ name: f, url: `/models/${f}` })));
  }
  if (parts[1] === "glb-upload" && parts.length === 2 && req.method === "POST") {
    try {
      const { filename, dataBase64 } = await readJsonBody(req);
      if (!dataBase64) throw new Error("No file data received");
      const fileBuf = Buffer.from(dataBase64, "base64");
      const safeName = (filename || "model.glb").replace(/[^A-Za-z0-9 _.-]/g, "").trim() || "model.glb";
      const finalName = safeName.toLowerCase().endsWith(".glb") ? safeName : `${safeName}.glb`;
      fs.writeFileSync(path.join(MODELS_DIR, finalName), fileBuf);
      return sendJson(res, 200, { ok: true, url: `/models/${finalName}` });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // Generic image upload (Layout page backgrounds) - deliberately a
  // separate endpoint/directory from glb-upload above rather than reused:
  // that route force-renames anything uploaded through it to end in
  // ".glb" and serves it as model/gltf-binary, which would mislabel a
  // real JPEG/PNG background image.
  const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg"]);
  if (parts[1] === "image-upload" && parts.length === 2 && req.method === "POST") {
    try {
      const { filename, dataBase64 } = await readJsonBody(req);
      if (!dataBase64) throw new Error("No file data received");
      const fileBuf = Buffer.from(dataBase64, "base64");
      const safeName = (filename || "image.png").replace(/[^A-Za-z0-9 _.-]/g, "").trim() || "image.png";
      const ext = path.extname(safeName).toLowerCase();
      const finalName = IMAGE_EXTS.has(ext) ? safeName : `${safeName}.png`;
      fs.writeFileSync(path.join(IMAGES_DIR, finalName), fileBuf);
      return sendJson(res, 200, { ok: true, url: `/images/${finalName}` });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }
  res.writeHead(404);
  res.end("Not found");
}

module.exports = { routes, serveStatic };
