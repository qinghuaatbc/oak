// Real HTTP requests against the real server.js http.Server, on an
// ephemeral port - not a mock. Mirrors this session's own earlier
// v8-mini-node/test.sh philosophy (real curl-style requests over mocking)
// applied to Oak's own server. ADMIN_PASSWORD is set before server.js is
// require()'d (module load time reads process.env once, via auth.js) so
// the login flow this file exercises is real, not stubbed out.
process.env.ADMIN_PASSWORD = "test-only-password-not-a-real-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { server } = require("../server.js");

function request(port, method, urlPath, { body, cookie, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers: {
          ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
      },
      (res) => {
        let responseBody = "";
        res.on("data", (chunk) => (responseBody += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: responseBody, headers: res.headers }));
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// Extracts just the cookie's name=value pair from a Set-Cookie header,
// dropping the Path/Max-Age/HttpOnly/etc attributes - what a browser would
// actually send back on the next request's own Cookie header.
function sessionCookieFrom(setCookieHeader) {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  return raw.split(";")[0];
}

async function withServer(fn) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    await fn(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("an unauthenticated API request is rejected with 401, not silently served", () =>
  withServer(async (port) => {
    const res = await request(port, "GET", "/api/health");
    assert.equal(res.status, 401);
  }));

test("an unauthenticated page request redirects to the login page, not served directly", () =>
  withServer(async (port) => {
    const res = await request(port, "GET", "/admin.html");
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /^\/login\.html\?next=/);
  }));

test("/login.html and /api/login stay reachable without a session (or nothing could ever log in)", () =>
  withServer(async (port) => {
    const loginPage = await request(port, "GET", "/login.html");
    assert.equal(loginPage.status, 200);
    const wrongPassword = await request(port, "POST", "/api/login", { body: { password: "definitely-wrong" } });
    assert.equal(wrongPassword.status, 401);
  }));

test("the right password logs in, and the resulting session cookie unlocks a previously-401 route", () =>
  withServer(async (port) => {
    const login = await request(port, "POST", "/api/login", { body: { password: process.env.ADMIN_PASSWORD } });
    assert.equal(login.status, 200);
    assert.ok(login.headers["set-cookie"], "expected /api/login to set a session cookie");
    const cookie = sessionCookieFrom(login.headers["set-cookie"]);
    assert.match(cookie, /^oak_session=/);

    const health = await request(port, "GET", "/api/health", { cookie });
    assert.equal(health.status, 200);
  }));

test("the session cookie is Secure over HTTPS (behind a proxy) and not over plain http, where a browser would drop it", () =>
  withServer(async (port) => {
    const plain = await request(port, "POST", "/api/login", { body: { password: process.env.ADMIN_PASSWORD } });
    assert.doesNotMatch(String(plain.headers["set-cookie"]), /Secure/);
    const proxied = await request(port, "POST", "/api/login", { body: { password: process.env.ADMIN_PASSWORD }, headers: { "X-Forwarded-Proto": "https" } });
    assert.match(String(proxied.headers["set-cookie"]), /; Secure;/);
  }));

test("logging out invalidates the session - the same cookie stops working afterward", () =>
  withServer(async (port) => {
    const login = await request(port, "POST", "/api/login", { body: { password: process.env.ADMIN_PASSWORD } });
    const cookie = sessionCookieFrom(login.headers["set-cookie"]);

    const beforeLogout = await request(port, "GET", "/api/health", { cookie });
    assert.equal(beforeLogout.status, 200);

    const logout = await request(port, "POST", "/api/logout", { cookie });
    assert.equal(logout.status, 200);

    const afterLogout = await request(port, "GET", "/api/health", { cookie });
    assert.equal(afterLogout.status, 401);
  }));

test("GET /api/not-a-real-route returns a real 404 once authenticated, not a silent success", () =>
  withServer(async (port) => {
    const login = await request(port, "POST", "/api/login", { body: { password: process.env.ADMIN_PASSWORD } });
    const cookie = sessionCookieFrom(login.headers["set-cookie"]);
    const res = await request(port, "GET", "/api/not-a-real-route", { cookie });
    assert.equal(res.status, 404);
  }));
