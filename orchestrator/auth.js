// Session-cookie login, replacing Caddy's basic_auth as the thing that
// actually protects the admin/live UI. basic_auth was disabled on the live
// VPS on 2026-08-14 because iOS "Add to Home Screen" PWA launches hung
// against the native Basic Auth challenge - a real, structural iOS/WebKit
// limitation (Safari's Basic Auth credential prompt/caching behaves
// unreliably in standalone PWA display mode), not something fixable by
// reconfiguring Caddy. A session cookie doesn't have this problem - it's
// the standard fix for exactly this class of bug.
//
// Deliberately minimal: admin logins that all may do everything - no roles,
// no password reset by mail - matching the basic_auth model this replaces.
// There can be several (scripts/set-login.js adds one or changes one's
// password; --remove takes one away, never the last).
//
// Where the logins come from, first found wins:
//   1. orchestrator/admin.json - { username, salt, hash } for one login, or
//      { logins: [ ... ] } for several - written by scripts/set-login.js
//      (which the installers run); the same file as oak-rs's. The password is
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

/** @typedef {{ username: string, salt: string, hash: string }} Login */

/** @param {any} l @returns {l is Login} */
const isLogin = (l) => !!l && typeof l.username === "string" && typeof l.salt === "string" && typeof l.hash === "string";

/** The stored logins from admin.json; none if there is none (or it's unreadable). @returns {Login[]} */
function storedLogins() {
  try {
    const data = JSON.parse(fs.readFileSync(ADMIN_FILE, "utf8"));
    if (Array.isArray(data.logins)) return data.logins.filter(isLogin);
    if (isLogin(data)) return [data];
  } catch {}
  return [];
}

/** Writes admin.json, readable by this user only; one login as { username, salt, hash }. @param {Login[]} logins */
function saveLogins(logins) {
  const data = logins.length === 1 ? logins[0] : { logins };
  fs.writeFileSync(ADMIN_FILE, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(ADMIN_FILE, 0o600);
}

/** A login record for admin.json: the username, a fresh salt, and the password's scrypt hash. */
function makeLogin(username, password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString("hex");
  return { username: String(username), salt, hash };
}

function passwordConfigured() {
  return storedLogins().length > 0 || (typeof process.env.ADMIN_PASSWORD === "string" && process.env.ADMIN_PASSWORD.length > 0);
}

// Constant-time compare so a wrong guess doesn't leak timing information
// about how much of it matched. Both sides are hashed to the same length
// first, since crypto.timingSafeEqual throws on mismatched lengths - so a
// guess's length leaks nothing either.
function same(candidate, expected) {
  const digest = (s) => crypto.createHash("sha256").update(String(s ?? "")).digest();
  return crypto.timingSafeEqual(digest(candidate), digest(expected));
}

// Every stored login is tried, username and password both, and only then
// combined, so the response time doesn't tell a right username from a
// wrong one.
function checkLogin(username, password) {
  const logins = storedLogins();
  if (logins.length) {
    let found = false;
    for (const login of logins) {
      const userOk = same(username, login.username);
      const actual = crypto.scryptSync(String(password ?? ""), login.salt, SCRYPT_KEYLEN);
      const expected = Buffer.from(login.hash, "hex");
      const passOk = expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
      found = found || (userOk && passOk);
    }
    return found;
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

/**
 * The session cookie. Secure (sent over HTTPS only) when the request came
 * over HTTPS - directly, or through a proxy such as Caddy that says so in
 * X-Forwarded-Proto. Over plain http (Oak on a home network, at
 * http://192.168.x.x:8702) a Secure cookie is thrown away by the browser,
 * so signing in would seem to fail; there it is sent without the flag.
 */
function sessionCookie(req, value, maxAgeSeconds) {
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const https = req.socket?.encrypted || proto === "https";
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly;${https ? " Secure;" : ""} SameSite=Lax`;
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
    // Secure over HTTPS (see sessionCookie), SameSite=Lax (sent on normal
    // navigation, not on cross-site requests).
    res.setHeader("Set-Cookie", sessionCookie(req, token, Math.floor(SESSION_TTL_MS / 1000)));
    return sendJson(res, 200, { ok: true });
  });
}

function handleLogout(req, res, sendJson) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) sessions.delete(token);
  res.setHeader("Set-Cookie", sessionCookie(req, "", 0));
  return sendJson(res, 200, { ok: true });
}

module.exports = { hasValidSession, isPublicPath, handleLogin, handleLogout, passwordConfigured, SESSION_COOKIE, checkPassword, checkLogin, makeLogin, storedLogins, saveLogins, ADMIN_FILE };
