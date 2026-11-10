// The login check itself: admin.json (a username and a salted scrypt hash,
// as scripts/set-login.js writes it) and the older env-var setup it falls
// back to. OAK_ADMIN_FILE points auth.js at a file in a temp dir of this
// test's own, set before auth.js is require()'d (it reads it once, at load).
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oak-auth-"));
process.env.OAK_ADMIN_FILE = path.join(dir, "admin.json");

const test = require("node:test");
const assert = require("node:assert/strict");
const auth = require("../auth.js");

function withEnv(vars, fn) {
  const before = {};
  for (const [k, v] of Object.entries(vars)) { before[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test("with admin.json: the right username and password log in", () => {
  fs.writeFileSync(auth.ADMIN_FILE, JSON.stringify(auth.makeLogin("admin", "admin")));
  assert.equal(auth.checkLogin("admin", "admin"), true);
});

test("with admin.json: a wrong username, or a wrong password, does not", () => {
  fs.writeFileSync(auth.ADMIN_FILE, JSON.stringify(auth.makeLogin("admin", "s3cret")));
  assert.equal(auth.checkLogin("root", "s3cret"), false);
  assert.equal(auth.checkLogin("admin", "wrong"), false);
  assert.equal(auth.checkLogin("admin", ""), false);
  assert.equal(auth.checkLogin(undefined, undefined), false);
});

test("admin.json keeps only a salted hash, never the password itself", () => {
  const login = auth.makeLogin("admin", "plain-text-password");
  assert.ok(!JSON.stringify(login).includes("plain-text-password"));
  assert.notEqual(auth.makeLogin("admin", "same").salt, auth.makeLogin("admin", "same").salt);
});

test("with admin.json, the env vars are not used", () => {
  fs.writeFileSync(auth.ADMIN_FILE, JSON.stringify(auth.makeLogin("admin", "from-file")));
  withEnv({ ADMIN_USER: "envuser", ADMIN_PASSWORD: "from-env" }, () => {
    assert.equal(auth.checkLogin("envuser", "from-env"), false);
    assert.equal(auth.checkLogin("admin", "from-file"), true);
  });
});

test("no admin.json: falls back to ADMIN_USER and ADMIN_PASSWORD", () => {
  fs.rmSync(auth.ADMIN_FILE, { force: true });
  withEnv({ ADMIN_USER: "boss", ADMIN_PASSWORD: "pw" }, () => {
    assert.equal(auth.passwordConfigured(), true);
    assert.equal(auth.checkLogin("boss", "pw"), true);
    assert.equal(auth.checkLogin("someone", "pw"), false);
  });
});

test("no admin.json and no ADMIN_USER: only the password is checked (older installs keep working)", () => {
  fs.rmSync(auth.ADMIN_FILE, { force: true });
  withEnv({ ADMIN_USER: undefined, ADMIN_PASSWORD: "pw" }, () => {
    assert.equal(auth.checkLogin("anything", "pw"), true);
    assert.equal(auth.checkLogin("anything", "nope"), false);
  });
});

test("no admin.json and no ADMIN_PASSWORD: no login is set up", () => {
  fs.rmSync(auth.ADMIN_FILE, { force: true });
  withEnv({ ADMIN_USER: undefined, ADMIN_PASSWORD: undefined }, () => {
    assert.equal(auth.passwordConfigured(), false);
  });
});
