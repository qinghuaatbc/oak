"use strict";
// Standalone fake multi-zone hub for testing zone-hub's slot-binding
// scenario - two zones (kitchen, livingroom), each with its own light
// on/level and climate target, all served by ONE process (mirroring how a
// single real hub instance backs multiple Dashboard slots).
const http = require("http");
const url = require("url");

const PORT = parseInt(process.argv[2] || "8083", 10);
const zones = {
  kitchen: { on: false, level: 0, target: 70 },
  livingroom: { on: false, level: 0, target: 68 },
};

const server = http.createServer((req, res) => {
  const { pathname, query } = url.parse(req.url, true);
  res.setHeader("Content-Type", "application/json");

  if (pathname === "/zones") {
    return res.end(JSON.stringify(zones));
  }
  if (pathname === "/light" && query.zone && zones[query.zone]) {
    const z = zones[query.zone];
    if (query.turn === "on") z.on = true;
    if (query.turn === "off") z.on = false;
    if (query.level !== undefined) {
      z.level = Math.max(0, Math.min(100, Number(query.level)));
      if (z.level > 0) z.on = true;
    }
    return res.end(JSON.stringify(z));
  }
  if (pathname === "/climate" && query.zone && zones[query.zone]) {
    const z = zones[query.zone];
    if (query.target !== undefined) z.target = Number(query.target);
    return res.end(JSON.stringify(z));
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, () => console.log(`fake zone-hub listening on :${PORT}`));
