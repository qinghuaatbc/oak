"use strict";
// End-to-end demo: spins up a fake "Envisalink" TCP server that speaks the
// DSC TPI handshake, then loads the DSC PowerSeries driver against it using
// Oak's own runtime. No RTI processor, no RTI SDK, no RTI mock harness
// involved anywhere in this file - just Node's net module and Oak's own
// loader.

const net = require("net");
const path = require("path");
const { loadDriver } = require("../runtime/loader");

function checksum(payload) {
  let sum = 0;
  for (let i = 0; i < payload.length; i++) sum += payload.charCodeAt(i) & 0xff;
  return (sum % 256).toString(16).toUpperCase().padStart(2, "0");
}
function frame(cmd, data) {
  const payload = cmd + (data || "");
  return payload + checksum(payload) + "\r\n";
}

const server = net.createServer((socket) => {
  console.log("[fake-envisalink] client connected, sending 505 login request");
  socket.write(frame("505"));
  socket.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    console.log("[fake-envisalink] received:", JSON.stringify(text));
    if (text.startsWith("005")) {
      socket.write(frame("500"));
      setTimeout(() => {
        console.log("[fake-envisalink] simulating zone 1 open");
        socket.write(frame("609", "001"));
      }, 500);
    }
  });
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  console.log(`[fake-envisalink] listening on 127.0.0.1:${port}`);

  const driver = loadDriver(path.join(__dirname, "..", "drivers", "dsc-powerseries"), {
    connection: { host: "127.0.0.1", port },
    settings: { password: "user", accessCode: "1234" },
  });

  driver.on("event", (ev) => console.log("[driver event]", ev.id, ev.params));
  driver.on("state", (s) => console.log("[driver state]", s.id, s.instanceKey, "=", s.value));
  driver.on("error", (e) => console.log("[driver error]", e.where, e.error.message));

  driver.start();

  setTimeout(() => {
    console.log("[demo] calling armStay action");
    driver.action("armStay", { partition: 1 });
  }, 1500);

  setTimeout(() => {
    console.log("[demo] shutting down");
    driver.connection.close();
    server.close();
    process.exit(0);
  }, 3000);
});
