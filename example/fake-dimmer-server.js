"use strict";
// Standalone fake dimmable light for manual/integration testing.
const http = require("http");

let on = false;
let level = 50;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/light") {
    const turn = url.searchParams.get("turn");
    const lvl = url.searchParams.get("level");
    if (turn === "on") on = true;
    else if (turn === "off") on = false;
    if (lvl !== null) {
      level = Math.max(0, Math.min(100, parseInt(lvl, 10)));
      on = level > 0;
    }
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ison: on, level }));
  }
  res.statusCode = 404;
  res.end();
});

const port = parseInt(process.env.PORT || "8082", 10);
server.listen(port, "127.0.0.1", () => console.log(`[fake-dimmer] listening on 127.0.0.1:${port}`));
