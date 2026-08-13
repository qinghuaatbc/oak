"use strict";
// Standalone fake HTTP relay for manual/integration testing against the
// orchestrator.
const http = require("http");

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

const port = parseInt(process.env.PORT || "8081", 10);
server.listen(port, "127.0.0.1", () => console.log(`[fake-relay] listening on 127.0.0.1:${port}`));
