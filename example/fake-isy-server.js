"use strict";
// Standalone fake ISY994/eisy for testing Oak's eisy driver - serves the
// same /rest/status XML shape, /rest/nodes/<address>/cmd/<cmd> command
// endpoints, and /rest/subscribe real-time WebSocket event stream
// Universal Devices' real controller does (see drivers/eisy/driver.js's
// header comment for why this is UDI's own public API, not anything
// RTI-specific - confirmed against a real eisy unit, not guessed). Two
// lighting nodes plus one thermostat node, matching the scenario the
// driver's manifest is built around.
const http = require("http");
const url = require("url");
const WebSocketServer = require("ws").Server;

const PORT = parseInt(process.argv[2] || "8084", 10);

const NAMES = {
  "18 22 4B 1": "Living Room",
  "19 33 5C 1": "Kitchen",
  "20 44 6D 1": "Thermostat",
};
const nodes = {
  "18 22 4B 1": { ST: 0 }, // living room light, Insteon-native 0-255
  "19 33 5C 1": { ST: 0 }, // kitchen light
  "20 44 6D 1": { CLISPH: 680, CLISPC: 760 }, // thermostat, x10 degrees F
};

function nodeListXml() {
  // Real hardware always puts attributes (flag, nodeDefId, ...) on the
  // opening <node> tag - deliberately replicated here (not simplified to
  // a bare <node>) since a bare tag doesn't exercise the same parsing
  // path the driver's regex has to handle against a real unit.
  const body = Object.keys(nodes)
    .map((address) => `<node flag="128" nodeDefId="DimmerLampSwitch_ADV"><address>${address}</address><name>${NAMES[address] || address}</name></node>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><nodes>${body}</nodes>`;
}

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

const wsClients = new Set();
let seqnum = 0;
function broadcastEvent(node, control, action) {
  seqnum++;
  // <action> carries uom/prec attributes on a real eisy unit (confirmed
  // by capturing actual traffic) - included here deliberately so this
  // mock actually exercises the driver's real parsing code path instead
  // of passing against a simplified shape a real device never sends.
  const xml = `<Event seqnum="${seqnum}" sid="uuid:1"><control>${control}</control><action uom="100" prec="0">${action}</action><node>${node}</node><eventInfo/></Event>`;
  for (const client of wsClients) {
    if (client.readyState === client.OPEN) client.send(xml);
  }
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
  if (pathname === "/rest/nodes") {
    return res.end(nodeListXml());
  }

  // /rest/nodes/<address>/cmd/<control>[/<value>]
  const m = pathname.match(/^\/rest\/nodes\/([^/]+)\/cmd\/([A-Z]+)(?:\/(\d+))?$/);
  if (m) {
    const [, address, control, value] = m;
    const decoded = decodeURIComponent(address);
    const node = nodes[decoded];
    if (!node) {
      res.statusCode = 404;
      return res.end(`<RestResponse><status>404</status></RestResponse>`);
    }
    // DON/DOF are commands (what you send); the resulting event always
    // reports the property that actually changed ("ST"), never the
    // command name itself - confirmed against the real device's own
    // event stream, not assumed.
    let changedProp;
    if (control === "DON") {
      node.ST = value !== undefined ? Number(value) : 255;
      changedProp = "ST";
    } else if (control === "DOF") {
      node.ST = 0;
      changedProp = "ST";
    } else if (control === "CLISPH") {
      node.CLISPH = Number(value);
      changedProp = "CLISPH";
    } else if (control === "CLISPC") {
      node.CLISPC = Number(value);
      changedProp = "CLISPC";
    }
    if (changedProp) broadcastEvent(decoded, changedProp, node[changedProp]);
    return res.end(`<RestResponse><status>200</status></RestResponse>`);
  }

  res.statusCode = 404;
  res.end(`<RestResponse><status>404</status></RestResponse>`);
});

// Real eisy requires Sec-WebSocket-Protocol: ISYSUB plus a specific
// Origin header on the subscribe handshake (confirmed against real
// hardware - a bare upgrade with neither gets a 400) - reject anything
// that doesn't send both, so this test double actually exercises the
// driver's real handshake code instead of accepting anything.
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/rest/subscribe" || req.headers["sec-websocket-protocol"] !== "ISYSUB" || req.headers.origin !== "com.universal-devices.websockets.isy") {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wsClients.add(ws);
    ws.on("close", () => wsClients.delete(ws));
    ws.send(`<?xml version="1.0" encoding="UTF-8"?><SubscriptionResponse><SID>uuid:1</SID><duration>0</duration></SubscriptionResponse>`);
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(`[fake-isy] listening on 127.0.0.1:${PORT}`));
