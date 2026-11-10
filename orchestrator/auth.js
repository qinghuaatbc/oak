// Session-cookie login, replacing Caddy's basic_auth as the thing that
// actually protects the admin/live UI. basic_auth was disabled on the live
// VPS on 2026-08-14 because iOS "Add to Home Screen" PWA launches hung
// against the native Basic Auth challenge - a real, structural iOS/WebKit
// limitation (Safari's Basic Auth credential prompt/caching behaves
// unreliably in standalone PWA display mode), not something fixable by
// reconfiguring Caddy. A session cookie doesn't have this problem - it's
// the standard fix for exactly this class of bug.
//
// Deliberately minimal: one admin login, not a user table - matching the
// simplicity of the basic_auth model this replaces, not adding scope
// (per-user accounts, password reset, etc.) nobody asked for on a
// self-hosted single-operator tool.
//
// Where the login comes from, first found wins:
//   1. orchestrator/admin.json - { username, salt, hash }, written by
//      scripts/set-login.js (which the installers run). The password is
//      kept only as a salted scrypt hash, never in plain text. Read on
//      every login attempt, so a changed login works without a restart.
//   2. ADMIN_PASSWORD (and optionally ADMIN_USER) env vars - how installs
//      from before admin.json existed are set up, e.g. the live VPS. With
//      no ADMIN_USER, the username isn't checked, so those keep working.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SESSION_COOKIE = "oak_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const sessions = new Map(); // token -> expiresAt (ms since epoch)
// (OAK_ADMIN_FILE lets the tests point at a file of their own.)
const ADMIN_FILE = process.env.OAK_ADMIN_FILE || path.join(__dirname, "admin.json");
const SCRYPT_KEYLEN = 64;

/** The stored login from admin.json, or null if there is none (or it's unreadable). */
function storedLogin() {
  try {
    const login = JSON.parse(fs.readFileSync(ADMIN_FILE, "utf8"));
    if (typeof login.username === "string" && typeof login.salt === "string" && typeof login.hash === "string") return login;
  } catch {}
  return null;
}

/** A login record for admin.json: the username, a fresh salt, and the password's scrypt hash. */
function makeLogin(username, password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString("hex");
  return { username: String(username), salt, hash };
}

function passwordConfigured() {
  return storedLogin() !== null || (typeof process.env.ADMIN_PASSWORD === "string" && process.env.ADMIN_PASSWORD.length > 0);
}

// Constant-time compare so a wrong guess doesn't leak timing information
// about how much of it matched. Both sides are hashed to the same length
// first, since crypto.timingSafeEqual throws on mismatched lengths - so a
// guess's length leaks nothing either.
function same(candidate, expected) {
  const digest = (s) => crypto.createHash("sha256").update(String(s ?? "")).digest();
  return crypto.timingSafeEqual(digest(candidate), digest(expected));
}

// Both the username and the password are always compared, and only then
// combined, so the response time doesn't tell a right username from a
// wrong one.
function checkLogin(username, password) {
  const login = storedLogin();
  if (login) {
    const userOk = same(username, login.username);
    const actual = crypto.scryptSync(String(password ?? ""), login.salt, SCRYPT_KEYLEN);
    const passOk = crypto.timingSafeEqual(actual, Buffer.from(login.hash, "hex"));
    return userOk && passOk;
  }
  const userOk = process.env.ADMIN_USER ? same(username, process.env.ADMIN_USER) : true;
  const passOk = same(password, process.env.ADMIN_PASSWORD || "");
  return userOk && passOk;
}

/** The password alone (the env-var setup, with no username): kept for older callers. */
function checkPassword(candidate) {
  return same(candidate, process.env.ADMIN_PASSWORD || "");
}

function sweepExpiredSessions() {
  const now = Date.now();
  for (const [token, expiresAt] of sessions) {
    if (expiresAt <= now) sessions.delete(token);
  }
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

// True if this request carries a still-valid session cookie. Called once
// per request from server.js's own routing, not middleware in a framework
// sense - this project has no framework, so this is just a plain function
// the caller checks before deciding whether to keep handling the request.
function hasValidSession(req) {
  sweepExpiredSessions();
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return false;
  const expiresAt = sessions.get(token);
  return typeof expiresAt === "number" && expiresAt > Date.now();
}

// Paths that must stay reachable without a session - the login page and
// the endpoint that creates one. WebSocket upgrades are handled by
// server.js's own `server.on("upgrade", ...)` listener, a separate code path
// from the http.createServer request callback this check runs inside of;
// that listener calls hasValidSession() itself.
const PUBLIC_PATHS = new Set(["/login.html", "/api/login"]);

function isPublicPath(pathname) {
  return PUBLIC_PATHS.has(pathname);
}

function handleLogin(req, res, readJsonBody, sendJson) {
  if (!passwordConfigured()) {
    return sendJson(res, 500, { error: "No login is set up on the server yet - run `node scripts/set-login.js` there (or set ADMIN_PASSWORD), then try again." });
  }
  return readJsonBody(req).then((body) => {
    if (!checkLogin(body.username, body.password)) {
      return sendJson(res, 401, { error: "Wrong username or password" });
    }
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    // HttpOnly (JS on the page can't read it - nothing to steal via XSS),
    // Secure (only sent over HTTPS - the live deployment is HTTPS-only
    // behind Caddy; local http://localhost testing still works because
    // browsers special-case "Secure" as not required for localhost),
    // SameSite=Lax (sent on normal navigation, not on cross-site requests).
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; HttpOnly; Secure; SameSite=Lax`);
    return sendJson(res, 200, { ok: true });
  });
}

function handleLogout(req, res, sendJson) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) sessions.delete(token);
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
  return sendJson(res, 200, { ok: true });
}

module.exports = { hasValidSession, isPublicPath, handleLogin, handleLogout, passwordConfigured, SESSION_COOKIE, checkPassword, checkLogin, makeLogin, ADMIN_FILE };
