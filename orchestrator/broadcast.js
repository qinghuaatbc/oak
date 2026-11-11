"use strict";
// Every browser connected to /ws, and the one way to push a message to all
// of them (state changes, events, "macros changed", ...).

/** @type {Set<{send(json: string): void}>} */
const wsClients = new Set();

function broadcast(msg) {
  const json = JSON.stringify(msg);
  for (const client of wsClients) client.send(json);
}

module.exports = { wsClients, broadcast };
