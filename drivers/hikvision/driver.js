"use strict";
// Hikvision camera/NVR driver over ISAPI - Hikvision's own published
// integrator API (an XML/HTTP REST-ish API documented in their "ISAPI
// Developer Guide" PDFs, and this device family is by far the largest
// single install base in the security camera/NVR industry, largely
// white-labeled under many other brand names too). High confidence on
// the endpoint shapes.
//
// Most Hikvision devices require HTTP Digest auth by default (Basic auth
// is often disabled entirely), so this driver implements RFC 2617/7616
// Digest auth by hand (MD5-based challenge/response) rather than
// assuming Basic works - a real, standard, non-vendor-specific protocol,
// not a guess, but genuinely needed since fetch() has no built-in Digest
// support.
const crypto = require("crypto");

function md5(str) {
  return crypto.createHash("md5").update(str).digest("hex");
}
function parseDigestChallenge(header) {
  const params = {};
  const re = /(\w+)=(?:"([^"]*)"|([^,]*))/g;
  let m;
  while ((m = re.exec(header))) params[m[1]] = m[2] !== undefined ? m[2] : m[3];
  return params;
}
function buildDigestHeader(challenge, method, uri, username, password) {
  const ha1 = md5(`${username}:${challenge.realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const nc = "00000001";
  const cnonce = crypto.randomBytes(8).toString("hex");
  const qop = (challenge.qop || "").split(",")[0].trim();
  const response = qop
    ? md5(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${challenge.nonce}:${ha2}`);
  let header = `Digest username="${username}", realm="${challenge.realm}", nonce="${challenge.nonce}", uri="${uri}", response="${response}"`;
  if (qop) header += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  if (challenge.opaque) header += `, opaque="${challenge.opaque}"`;
  return header;
}

function create(ctx) {
  const host = ctx.config.connection.host;
  const port = ctx.config.connection.port || 80;
  const base = `http://${host}:${port}`;

  async function isapi(path, opts) {
    const { username, password } = ctx.config.settings;
    const uri = path;
    let res = await fetch(`${base}${uri}`, opts);
    if (res.status === 401 && username) {
      const wwwAuth = res.headers.get("www-authenticate") || "";
      if (/^Digest/i.test(wwwAuth)) {
        const challenge = parseDigestChallenge(wwwAuth.replace(/^Digest\s+/i, ""));
        const authHeader = buildDigestHeader(challenge, (opts && opts.method) || "GET", uri, username, password || "");
        res = await fetch(`${base}${uri}`, { ...opts, headers: { ...(opts && opts.headers), Authorization: authHeader } });
      } else {
        const basic = Buffer.from(`${username}:${password || ""}`).toString("base64");
        res = await fetch(`${base}${uri}`, { ...opts, headers: { ...(opts && opts.headers), Authorization: `Basic ${basic}` } });
      }
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }

  ctx.onAction("enableMotionDetection", async () => {
    const channel = ctx.config.settings.channel || 1;
    try {
      await isapi(`/ISAPI/System/Video/inputs/channels/${channel}/motionDetection`, {
        method: "PUT",
        headers: { "Content-Type": "application/xml" },
        body: `<MotionDetection><enabled>true</enabled></MotionDetection>`,
      });
    } catch (err) {
      ctx.log(`enableMotionDetection failed: ${err.message}`);
    }
  });
  ctx.onAction("disableMotionDetection", async () => {
    const channel = ctx.config.settings.channel || 1;
    try {
      await isapi(`/ISAPI/System/Video/inputs/channels/${channel}/motionDetection`, {
        method: "PUT",
        headers: { "Content-Type": "application/xml" },
        body: `<MotionDetection><enabled>false</enabled></MotionDetection>`,
      });
    } catch (err) {
      ctx.log(`disableMotionDetection failed: ${err.message}`);
    }
  });
  ctx.onAction("triggerOutput", async ({ outputId = 1 }) => {
    try {
      await isapi(`/ISAPI/System/IO/outputs/${outputId}/trigger`, {
        method: "PUT",
        headers: { "Content-Type": "application/xml" },
        body: `<IOPortData><outputState>high</outputState></IOPortData>`,
      });
    } catch (err) {
      ctx.log(`triggerOutput failed: ${err.message}`);
    }
  });
  ctx.onAction("reboot", async () => {
    try {
      await isapi("/ISAPI/System/reboot", { method: "PUT" });
    } catch (err) {
      ctx.log(`reboot failed: ${err.message}`);
    }
  });

  return {
    onConnect() {},
    onDisconnect() {},
  };
}

module.exports = { create };
