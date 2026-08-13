"use strict";
// End-to-end demo for the mqtt-plug driver: fork the fake broker as a
// child process (its own TCP server, matching how a real broker runs
// independently of the driver) and load the real driver against it.
const { spawn } = require("child_process");
const path = require("path");
const { loadDriver } = require("../runtime/loader");

const PORT = 18830 + Math.floor(Math.random() * 1000);
const broker = spawn(process.execPath, [path.join(__dirname, "fake-mqtt-broker.js")], {
  env: { ...process.env, PORT: String(PORT) },
});
broker.stdout.on("data", (d) => process.stdout.write(d));
broker.stderr.on("data", (d) => process.stderr.write(d));

setTimeout(() => {
  const driver = loadDriver(path.join(__dirname, "..", "drivers", "mqtt-plug"), {
    connection: { host: "127.0.0.1", port: PORT, transport: "tcp" },
    settings: { baseTopic: "home/plug1", clientId: "oak-demo" },
  });

  driver.on("event", (ev) => console.log("[driver event]", ev.id, ev.params));
  driver.on("state", (s) => console.log("[driver state]", s.id, s.instanceKey, "=", s.value));
  driver.on("error", (e) => console.log("[driver error]", e.where, e.error.message));

  driver.start();

  setTimeout(() => {
    console.log("[demo] calling turnOn action");
    driver.action("turnOn", {});
  }, 1000);

  setTimeout(() => {
    console.log("[demo] shutting down");
    driver.connection.close();
    broker.kill();
    process.exit(0);
  }, 2500);
}, 300);
