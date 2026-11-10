// Session-cookie login, replacing Caddy's basic_auth as the thing that
// actually protects the admin/live UI. basic_auth was disabled on the live
// VPS on 2026-08-14 because iOS "Add to Home Screen" PWA launches hung
// against the native Basic Auth challenge - a real, structural iOS/WebKit
// limitation (Safari's Basic Auth credential prompt/caching behaves
// unreliably in standalone PWA display mode), not something fixable by
// reconfiguring Caddy. A session cookie doesn't have this problem - it's
// the standard fix for exactly this class of bug.
//
// Deliberately minimal: one shared admin password (ADMIN_PASSWORD env var),
// not a user table - matching the simplicity of the basic_auth model this
// replaces, not adding scope (per-user accounts, password reset, etc.)
// nobody asked for on a self-hosted single-operator tool.
const crypto = require("crypto");

const SESSION_COOKIE = "oak_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const sessions = new Map(); // token -> expiresAt (ms since epoch)

function passwordConfigured() {
  return typeof process.env.ADMIN_PASSWORD === "string" && process.env.ADMIN_PASSWORD.length > 0;
}

// Constant-time compare so a wrong-length or wrong-content guess doesn't
// leak timing information about how much of the password matched -
// crypto.timingSafeEqual itself throws on mismatched lengths, so the
// length check has to happen first (and is fine to be a fast/non-constant
// check, unlike the actual byte comparison - password length isn't the
// secret here, its content is).
function checkPassword(candidate) {
  const expected = Buffer.from(process.env.ADMIN_PASSWORD || "");
  const actual = Buffer.from(String(candidate || ""));
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
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
    return sendJson(res, 500, { error: "ADMIN_PASSWORD is not set on the server - login is not possible until it is." });
  }
  return readJsonBody(req).then((body) => {
    if (!checkPassword(body.password)) {
      return sendJson(res, 401, { error: "Wrong password" });
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

module.exports = { hasValidSession, isPublicPath, handleLogin, handleLogout, passwordConfigured, SESSION_COOKIE, checkPassword };
