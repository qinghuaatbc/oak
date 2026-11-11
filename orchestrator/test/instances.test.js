// An instance's whole life over the real REST API: add, act, stop, edit,
// start, delete - against the real http-relay driver talking to a fake relay
// device this file starts itself. Every file server.js reads or writes is
// pointed at a temp dir of this test's own, set before server.js is
// require()'d (it reads these paths once, at load), so the real config.json
// is never touched.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oak-instances-"));
const CONFIG = path.join(dir, "config.json");
fs.writeFileSync(CONFIG, JSON.stringify({ instances: [] }));
Object.assign(process.env, {
  OAK_CONFIG: CONFIG,
  OAK_ADMIN_FILE: path.join(dir, "admin.json"),
  OAK_MACROS: path.join(dir, "macros.json"),
  OAK_AUTOMATIONS: path.join(dir, "automations.json"),
  OAK_SETTINGS: path.join(dir, "settings.json"),
  OAK_CAMERAS: path.join(dir, "cameras.json"),
  OAK_BINDINGS: path.join(dir, "bindings.json"),
  OAK_MODELS_DIR: path.join(dir, "models"),
  OAK_IMAGES_DIR: path.join(dir, "images"),
});

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const auth = require("../auth.js");
fs.writeFileSync(auth.ADMIN_FILE, JSON.stringify(auth.makeLogin("admin", "test-only")));
const { server } = require("../server.js");

// The fake relay: GET /relay/0[?turn=on|off|toggle] -> {ison}, the shape
// drivers/http-relay speaks (same as example/fake-relay-server.js).
let relayOn = false;
const relay = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname !== "/relay/0") return res.writeHead(404).end();
  const turn = url.searchParams.get("turn");
  if (turn === "on") relayOn = true;
  else if (turn === "off") relayOn = false;
  else if (turn === "toggle") relayOn = !relayOn;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ison: relayOn }));
});

let port, relayPort, cookie;

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers: {
          ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(text); } catch {}
          resolve({ status: res.statusCode, body: json, headers: res.headers });
        });
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

/** Retries `check` until it returns something truthy, or fails after `ms`. */
async function waitFor(check, ms = 3000) {
  const until = Date.now() + ms;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > until) assert.fail("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

const savedIds = () => JSON.parse(fs.readFileSync(CONFIG, "utf8")).instances.map((i) => i.id);
const listed = async (id) => (await request("GET", "/api/instances")).body.find((i) => i.id === id);

test.before(async () => {
  await new Promise((r) => relay.listen(0, "127.0.0.1", r));
  relayPort = relay.address().port;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
  const login = await request("POST", "/api/login", { username: "admin", password: "test-only" });
  assert.equal(login.status, 200);
  cookie = login.headers["set-cookie"][0].split(";")[0];
});

test.after(async () => {
  // (Deleting stops the driver's poll timer, so nothing keeps the process alive.)
  for (const i of (await request("GET", "/api/instances")).body) await request("DELETE", `/api/instances/${i.id}`);
  await new Promise((r) => server.close(r));
  await new Promise((r) => relay.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("adding an instance starts it and saves it to config.json", async () => {
  const res = await request("POST", "/api/instances", {
    id: "relay1",
    driver: "http-relay",
    connection: { transport: "http", host: "127.0.0.1", port: relayPort },
    settings: { pollIntervalMs: 60000 },
  });
  assert.equal(res.status, 200);
  const item = await listed("relay1");
  assert.equal(item.running, true);
  assert.equal(item.driver, "http-relay");
  assert.ok(item.actions.includes("turnOn"));
  assert.deepEqual(savedIds(), ["relay1"]);
});

test("an action reaches the device, and the state and event it causes are recorded", async () => {
  const res = await request("POST", "/api/instances/relay1/action/turnOn", { relay: 0 });
  assert.equal(res.status, 200);
  await waitFor(() => relayOn);
  const state = await waitFor(async () => {
    const s = (await request("GET", "/api/instances/relay1/state")).body;
    return s["relay.on#0"] === true && s;
  });
  assert.equal(state["relay.on#0"], true);
  const events = (await request("GET", "/api/instances/relay1/events")).body;
  assert.ok(events.some((e) => e.id === "stateChanged" && e.params.on === true));
});

test("an unknown action is refused, not silently accepted", async () => {
  const res = await request("POST", "/api/instances/relay1/action/explode", {});
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Unknown action/);
});

test("a running instance's connection can't be edited, but a keyvalue setting can", async () => {
  const conn = await request("PUT", "/api/instances/relay1", { connection: { port: 1 } });
  assert.equal(conn.status, 400);
  assert.match(conn.body.error, /Stop the instance/);
  const names = await request("PUT", "/api/instances/relay1", { settings: { relayNames: { 0: "Garage" } } });
  assert.equal(names.status, 200);
  const saved = JSON.parse(fs.readFileSync(CONFIG, "utf8")).instances[0];
  assert.deepEqual(saved.settings.relayNames, { 0: "Garage" });
});

test("stopping keeps the instance, its config and its last state; actions are refused while stopped", async () => {
  const res = await request("POST", "/api/instances/relay1/stop");
  assert.equal(res.status, 200);
  assert.equal((await listed("relay1")).running, false);
  assert.deepEqual(savedIds(), ["relay1"]);
  const state = (await request("GET", "/api/instances/relay1/state")).body;
  assert.equal(state["relay.on#0"], true);
  const action = await request("POST", "/api/instances/relay1/action/turnOff", {});
  assert.equal(action.status, 400);
  const again = await request("POST", "/api/instances/relay1/stop");
  assert.equal(again.status, 400);
});

test("a stopped instance's connection can be edited, and that is saved", async () => {
  const res = await request("PUT", "/api/instances/relay1", { connection: { port: relayPort }, label: "Garage relay" });
  assert.equal(res.status, 200);
  const config = (await request("GET", "/api/instances/relay1/config")).body;
  assert.equal(config.connection.port, relayPort);
  assert.equal(config.label, "Garage relay");
  const saved = JSON.parse(fs.readFileSync(CONFIG, "utf8")).instances[0];
  assert.equal(saved.label, "Garage relay");
});

test("starting again makes a fresh, working driver", async () => {
  const res = await request("POST", "/api/instances/relay1/start");
  assert.equal(res.status, 200);
  assert.equal((await listed("relay1")).running, true);
  const again = await request("POST", "/api/instances/relay1/start");
  assert.equal(again.status, 400);
  await request("POST", "/api/instances/relay1/action/turnOff", { relay: 0 });
  await waitFor(() => !relayOn);
});

test("bad ids, duplicates and unknown drivers are refused, and nothing is saved for them", async () => {
  const conn = { transport: "http", host: "127.0.0.1", port: relayPort };
  const spaced = await request("POST", "/api/instances", { id: "has space", driver: "http-relay", connection: conn });
  assert.equal(spaced.status, 400);
  const dup = await request("POST", "/api/instances", { id: "relay1", driver: "http-relay", connection: conn });
  assert.equal(dup.status, 400);
  const escape = await request("POST", "/api/instances", { id: "x", driver: "../runtime", connection: conn });
  assert.equal(escape.status, 400);
  const missing = await request("POST", "/api/instances", { id: "y", driver: "no-such-driver", connection: conn });
  assert.equal(missing.status, 400);
  assert.deepEqual(savedIds(), ["relay1"]);
});

test("deleting removes the instance everywhere", async () => {
  const res = await request("DELETE", "/api/instances/relay1");
  assert.equal(res.status, 200);
  assert.equal(await listed("relay1"), undefined);
  assert.equal((await request("GET", "/api/instances/relay1/state")).status, 404);
  assert.deepEqual(savedIds(), []);
  const again = await request("DELETE", "/api/instances/relay1");
  assert.equal(again.status, 404);
});
