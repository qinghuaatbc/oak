// Macros and automations against real driver instances: two http-relay
// instances (A and B), each talking to its own fake relay device started
// here, so "when A does something, do something to B" is tested end to end.
// Every file server.js reads or writes is pointed at a temp dir first, as in
// instances.test.js. TZ is fixed so sunrise/sunset times are predictable.
process.env.TZ = "America/Toronto";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oak-automations-"));
fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ instances: [] }));
Object.assign(process.env, {
  OAK_CONFIG: path.join(dir, "config.json"),
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
const { checkTimeAutomations, computeSunTimes } = require("../automations.js");

/** A fake relay device (GET /relay/0[?turn=on|off|toggle] -> {ison}) that counts the switches it was asked for. */
function fakeRelay() {
  const device = { on: false, turns: [], server: null, port: 0 };
  device.server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/relay/0") return res.writeHead(404).end();
    const turn = url.searchParams.get("turn");
    if (turn) device.turns.push(turn);
    if (turn === "on") device.on = true;
    else if (turn === "off") device.on = false;
    else if (turn === "toggle") device.on = !device.on;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ison: device.on }));
  });
  return device;
}
const A = fakeRelay();
const B = fakeRelay();

let port, cookie;

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
    await new Promise((r) => setTimeout(r, 20));
  }
}
const settle = () => new Promise((r) => setTimeout(r, 150));

/** Switches a relay through its instance and waits until the device and the instance's state agree. */
async function setRelay(id, device, on) {
  await request("POST", `/api/instances/${id}/action/${on ? "turnOn" : "turnOff"}`, { relay: 0 });
  await waitFor(async () => device.on === on && (await request("GET", `/api/instances/${id}/state`)).body["relay.on#0"] === on);
}

const relayOn = (instanceId, value) => ({ instanceId, stateId: "relay.on", stateSuffix: "0", op: "==", value });
const turn = (instanceId, on) => ({ type: "action", instanceId, actionId: on ? "turnOn" : "turnOff", params: { relay: 0 } });

test.before(async () => {
  for (const d of [A, B]) {
    await new Promise((r) => d.server.listen(0, "127.0.0.1", r));
    d.port = d.server.address().port;
  }
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
  const login = await request("POST", "/api/login", { username: "admin", password: "test-only" });
  cookie = login.headers["set-cookie"][0].split(";")[0];
  for (const [id, d] of [["A", A], ["B", B]]) {
    const res = await request("POST", "/api/instances", {
      id,
      driver: "http-relay",
      connection: { transport: "http", host: "127.0.0.1", port: d.port },
      settings: { pollIntervalMs: 60000 },
    });
    assert.equal(res.status, 200);
  }
  await waitFor(async () => (await request("GET", "/api/instances/B/state")).body["relay.on#0"] === false);
});

test.after(async () => {
  for (const i of (await request("GET", "/api/instances")).body) await request("DELETE", `/api/instances/${i.id}`);
  await new Promise((r) => server.close(r));
  for (const d of [A, B]) await new Promise((r) => d.server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a macro runs its steps in order, delays included", async () => {
  await setRelay("A", A, false);
  await setRelay("B", B, false);
  const saved = await request("POST", "/api/macros", { id: "both-on", name: "Both on", steps: [turn("A", true), { type: "delay", ms: 100 }, turn("B", true)] });
  assert.equal(saved.status, 200);
  await request("POST", "/api/macros/both-on/run");
  await waitFor(() => A.on);
  assert.equal(B.on, false, "B is switched only after the delay");
  await waitFor(() => B.on);
  const list = (await request("GET", "/api/macros")).body;
  assert.ok(list.some((m) => m.id === "both-on"));
  assert.ok(JSON.parse(fs.readFileSync(process.env.OAK_MACROS, "utf8")).some((m) => m.id === "both-on"));
});

test("a condition step takes the branch that matches the current state", async () => {
  await setRelay("A", A, true);
  await setRelay("B", B, true);
  await request("POST", "/api/macros", {
    id: "follow-a",
    name: "B follows A",
    steps: [{ type: "condition", conditions: [relayOn("A", true)], then: [turn("B", true)], else: [turn("B", false)] }],
  });
  await setRelay("A", A, false);
  await request("POST", "/api/macros/follow-a/run");
  await waitFor(() => !B.on);
  await setRelay("A", A, true);
  await request("POST", "/api/macros/follow-a/run");
  await waitFor(() => B.on);
});

test("a macro whose own conditions don't hold does nothing", async () => {
  await setRelay("A", A, false);
  await setRelay("B", B, false);
  await request("POST", "/api/macros", { id: "gated", name: "Gated", conditions: [relayOn("A", true)], steps: [turn("B", true)] });
  const before = B.turns.length;
  await request("POST", "/api/macros/gated/run");
  await settle();
  assert.equal(B.turns.length, before);
  assert.equal(B.on, false);
});

test("a step for a stopped instance is skipped and the rest of the macro still runs", async () => {
  await setRelay("B", B, false);
  await request("POST", "/api/instances/A/stop");
  await request("POST", "/api/macros", { id: "skip-a", name: "Skip A", steps: [turn("A", true), turn("B", true)] });
  await request("POST", "/api/macros/skip-a/run");
  await waitFor(() => B.on);
  await request("POST", "/api/instances/A/start");
});

test("an event on one instance can switch another (event automation)", async () => {
  await setRelay("A", A, false);
  await setRelay("B", B, false);
  await request("POST", "/api/automations", {
    id: "a-on-b-on",
    name: "When A changes, turn B on",
    trigger: { type: "event", instanceId: "A", eventId: "stateChanged" },
    action: { kind: "action", instanceId: "B", actionId: "turnOn", params: { relay: 0 } },
  });
  await setRelay("A", A, true); // A's driver emits stateChanged
  await waitFor(() => B.on);
  await request("DELETE", "/api/automations/a-on-b-on");
  await setRelay("B", B, false);
  await setRelay("A", A, false);
  await settle();
  assert.equal(B.on, false, "a deleted automation no longer fires");
});

test("an automation's conditions gate its action, and it can run a macro", async () => {
  await setRelay("A", A, false);
  await setRelay("B", B, false);
  await request("POST", "/api/macros", { id: "b-on", name: "B on", steps: [turn("B", true)] });
  await request("POST", "/api/automations", {
    id: "gated-auto",
    name: "Only while A is on",
    trigger: { type: "event", instanceId: "A", eventId: "none" },
    conditions: [relayOn("A", true)],
    action: { kind: "macro", macroId: "b-on" },
  });
  await request("POST", "/api/automations/gated-auto/run");
  await settle();
  assert.equal(B.on, false, "A is off, so the automation is skipped");
  await setRelay("A", A, true);
  await request("POST", "/api/automations/gated-auto/run");
  await waitFor(() => B.on);
  await request("DELETE", "/api/automations/gated-auto");
});

test("a time trigger fires once in its minute, only on its days, never with no days", async () => {
  await setRelay("B", B, true);
  const at1800Tuesday = new Date(2026, 10, 10, 18, 0, 5); // 10 Nov 2026 is a Tuesday (day 2)
  await request("POST", "/api/automations", {
    id: "evening",
    name: "B off at 18:00 on weekdays",
    trigger: { type: "time", time: "18:00", days: [1, 2, 3, 4, 5] },
    action: { kind: "action", instanceId: "B", actionId: "turnOff", params: { relay: 0 } },
  });
  const offs = () => B.turns.filter((t) => t === "off").length;
  const before = offs();

  checkTimeAutomations(new Date(2026, 10, 10, 17, 59, 30));
  await settle();
  assert.equal(offs(), before, "not before 18:00");

  checkTimeAutomations(at1800Tuesday);
  checkTimeAutomations(new Date(2026, 10, 10, 18, 0, 25)); // the timer runs every 20 s
  await waitFor(() => !B.on);
  await settle();
  assert.equal(offs(), before + 1, "once in that minute");

  await setRelay("B", B, true);
  checkTimeAutomations(new Date(2026, 10, 15, 18, 0, 5)); // a Sunday
  await settle();
  assert.equal(B.on, true, "not on a day it isn't set for");

  await request("POST", "/api/automations", {
    id: "evening",
    name: "No days ticked",
    trigger: { type: "time", time: "18:00", days: [] },
    action: { kind: "action", instanceId: "B", actionId: "turnOff", params: { relay: 0 } },
  });
  checkTimeAutomations(new Date(2026, 10, 11, 18, 0, 5));
  await settle();
  assert.equal(B.on, true, "an empty days list never fires");
  await request("DELETE", "/api/automations/evening");
});

test("a macro can have its own time trigger", async () => {
  await setRelay("A", A, false);
  await request("POST", "/api/macros", { id: "morning", name: "Morning", trigger: { type: "time", time: "07:30" }, steps: [turn("A", true)] });
  checkTimeAutomations(new Date(2026, 10, 12, 7, 30, 0));
  await waitFor(() => A.on);
  await request("DELETE", "/api/macros/morning");
});

test("sunrise and sunset are computed for the saved location", async () => {
  // Toronto on the summer solstice: sunrise 5:36, sunset 21:03 (EDT).
  const { sunrise, sunset } = computeSunTimes(new Date(2026, 5, 21, 12), 43.65, -79.38);
  const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
  assert.ok(Math.abs(minutes(sunrise) - (5 * 60 + 36)) <= 5, `sunrise ${sunrise}`);
  assert.ok(Math.abs(minutes(sunset) - (21 * 60 + 3)) <= 5, `sunset ${sunset}`);
  // No sunrise at all in the polar night.
  assert.equal(computeSunTimes(new Date(2026, 11, 21, 12), 78.2, 15.6).sunrise, null);
});

test("a sunset trigger with an offset fires at sunset plus the offset", async () => {
  await request("PUT", "/api/settings", { latitude: 43.65, longitude: -79.38 });
  assert.deepEqual((await request("GET", "/api/settings")).body, { latitude: 43.65, longitude: -79.38 });
  await setRelay("B", B, false);
  await request("POST", "/api/automations", {
    id: "dusk",
    name: "B on 30 min after sunset",
    trigger: { type: "time", mode: "sunset", offsetMin: 30 },
    action: { kind: "action", instanceId: "B", actionId: "turnOn", params: { relay: 0 } },
  });
  const today = new Date();
  const [h, m] = computeSunTimes(today, 43.65, -79.38).sunset.split(":").map(Number);
  const at = (minutesAfterSunset) => new Date(today.getFullYear(), today.getMonth(), today.getDate(), h, m + minutesAfterSunset, 1);
  checkTimeAutomations(at(0));
  await settle();
  assert.equal(B.on, false, "not at sunset itself");
  checkTimeAutomations(at(30));
  await waitFor(() => B.on);
  await request("DELETE", "/api/automations/dusk");
});

test("saving a macro or automation without the required fields is refused", async () => {
  assert.equal((await request("POST", "/api/macros", { name: "No steps", steps: [] })).status, 400);
  assert.equal((await request("POST", "/api/automations", { name: "No trigger", action: { kind: "macro", macroId: "x" } })).status, 400);
  assert.equal((await request("POST", "/api/macros/no-such-macro/run")).status, 404);
  assert.equal((await request("POST", "/api/automations/no-such-automation/run")).status, 404);
});
