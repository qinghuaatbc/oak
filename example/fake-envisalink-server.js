"use strict";
// Standalone fake Envisalink for manual/integration testing against the
// orchestrator (as opposed to demo.js, which spins one up inline).
const net = require("net");

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
  socket.write(frame("505"));
  socket.on("data", (chunk) => {
    if (chunk.toString("utf8").startsWith("005")) socket.write(frame("500"));
  });
});

const port = parseInt(process.env.PORT || "4025", 10);
server.listen(port, "127.0.0.1", () => console.log(`[fake-envisalink] listening on 127.0.0.1:${port}`));
