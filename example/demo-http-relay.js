"use strict";
// End-to-end demo for the http-relay driver: a fake local relay device
// (plain HTTP, no framing) plus Oak's real driver loading against it.

const http = require("http");
const path = require("path");
const { loadDriver } = require("../runtime/loader");

let relayOn = false;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/relay/0") {
    const turn = url.searchParams.get("turn");
    if (turn === "on") relayOn = true;
    else if (turn === "off") relayOn = false;
    else if (turn === "toggle") relayOn = !relayOn;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ison: relayOn }));
  }
  res.statusCode = 404;
  res.end();
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  console.log(`[fake-relay] listening on 127.0.0.1:${port}`);

  const driver = loadDriver(path.join(__dirname, "..", "drivers", "http-relay"), {
    connection: { host: "127.0.0.1", port, transport: "http" },
    settings: { pollIntervalMs: 1000 },
  });

  driver.on("event", (ev) => console.log("[driver event]", ev.id, ev.params));
  driver.on("state", (s) => console.log("[driver state]", s.id, s.instanceKey, "=", s.value));
  driver.on("error", (e) => console.log("[driver error]", e.where, e.error.message));

  driver.start();

  setTimeout(() => {
    console.log("[demo] calling turnOn action");
    driver.action("turnOn", { relay: 0 });
  }, 1200);

  setTimeout(() => {
    console.log("[demo] shutting down");
    server.close();
    process.exit(0);
  }, 3500);
});
