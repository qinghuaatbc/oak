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

test("several logins: each with its own password; one left is written as { username, salt, hash }", () => {
  auth.saveLogins([auth.makeLogin("admin", "one"), auth.makeLogin("anna", "two")]);
  assert.equal(auth.checkLogin("admin", "one"), true);
  assert.equal(auth.checkLogin("anna", "two"), true);
  assert.equal(auth.checkLogin("admin", "two"), false);
  assert.equal(auth.checkLogin("anna", "one"), false);
  assert.deepEqual(auth.storedLogins().map((l) => l.username), ["admin", "anna"]);
  auth.saveLogins([auth.makeLogin("anna", "two")]);
  assert.equal(JSON.parse(fs.readFileSync(auth.ADMIN_FILE, "utf8")).username, "anna");
});

test("set-login.js adds, changes, lists and removes logins, never the last", () => {
  const { execFileSync } = require("child_process");
  const run = (...a) => {
    try {
      return { out: execFileSync(process.execPath, [path.join(__dirname, "../../scripts/set-login.js"), ...a], { encoding: "utf8", stdio: "pipe" }), code: 0 };
    } catch (e) {
      return { out: String(e.stderr), code: e.status };
    }
  };
  fs.rmSync(auth.ADMIN_FILE, { force: true });
  assert.match(run("--user", "admin", "--password", "one").out, /Login added/);
  assert.match(run("--user", "anna", "--password", "two").out, /2 login\(s\)/);
  assert.match(run("--user", "anna", "--password", "three").out, /Password changed/);
  assert.equal(auth.checkLogin("anna", "three"), true);
  assert.equal(run("--list").out, "admin\nanna\n");
  assert.equal(run("--remove", "nobody").code, 1);
  assert.match(run("--remove", "admin").out, /1 login\(s\) left/);
  const last = run("--remove", "anna");
  assert.equal(last.code, 1);
  assert.match(last.out, /only login/);
  assert.equal(auth.checkLogin("anna", "three"), true);
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
