"use strict";
// Standalone fake ISY994/eisy for testing Oak's eisy driver - serves the
// same /rest/status XML shape and /rest/nodes/<address>/cmd/<cmd> command
// endpoints Universal Devices' real controller does (see drivers/eisy/
// driver.js's header comment for why this is UDI's own public API, not
// anything RTI-specific). Two lighting nodes plus one thermostat node,
// matching the scenario the driver's manifest is built around.
const http = require("http");
const url = require("url");

const PORT = parseInt(process.argv[2] || "8084", 10);

const nodes = {
  "18 22 4B 1": { ST: 0 }, // living room light, Insteon-native 0-255
  "19 33 5C 1": { ST: 0 }, // kitchen light
  "20 44 6D 1": { CLISPH: 680, CLISPC: 760 }, // thermostat, x10 degrees F
};

function statusXml() {
  const body = Object.entries(nodes)
    .map(([address, props]) => {
      const propXml = Object.entries(props)
        .map(([id, value]) => `<property id="${id}" value="${value}"/>`)
        .join("");
      return `<node id="${address}">${propXml}</node>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><nodes>${body}</nodes>`;
}

const server = http.createServer((req, res) => {
  // Real ISY994/eisy requires HTTP Basic Auth on every request - accept
  // any credentials here (this is a test double, not a security check).
  if (!req.headers.authorization || !req.headers.authorization.startsWith("Basic ")) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="ISY"' });
    return res.end();
  }
  const { pathname } = url.parse(req.url);
  res.setHeader("Content-Type", "text/xml");

  if (pathname === "/rest/status") {
    return res.end(statusXml());
  }

  // /rest/nodes/<address>/cmd/<control>[/<value>]
  const m = pathname.match(/^\/rest\/nodes\/([^/]+)\/cmd\/([A-Z]+)(?:\/(\d+))?$/);
  if (m) {
    const [, address, control, value] = m;
    const node = nodes[decodeURIComponent(address)];
    if (!node) {
      res.statusCode = 404;
      return res.end(`<RestResponse><status>404</status></RestResponse>`);
    }
    if (control === "DON") node.ST = value !== undefined ? Number(value) : 255;
    else if (control === "DOF") node.ST = 0;
    else if (control === "CLISPH") node.CLISPH = Number(value);
    else if (control === "CLISPC") node.CLISPC = Number(value);
    return res.end(`<RestResponse><status>200</status></RestResponse>`);
  }

  res.statusCode = 404;
  res.end(`<RestResponse><status>404</status></RestResponse>`);
});

server.listen(PORT, "127.0.0.1", () => console.log(`[fake-isy] listening on 127.0.0.1:${PORT}`));
