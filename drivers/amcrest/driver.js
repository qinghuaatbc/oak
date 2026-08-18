"use strict";
// Amcrest camera/NVR driver over its CGI-bin HTTP API - Amcrest devices
// are Dahua-family OEM (same underlying protocol family as many other
// "budget" camera brands), documented well enough via Amcrest's own
// developer API PDF and years of community use (similar in spirit to
// ../hikvision's ISAPI), high confidence. Reuses the same RFC 2617/7616
// Digest-auth implementation as ../hikvision, since these devices default
// to requiring it too.
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
  const response = qop ? md5(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${challenge.nonce}:${ha2}`);
  let header = `Digest username="${username}", realm="${challenge.realm}", nonce="${challenge.nonce}", uri="${uri}", response="${response}"`;
  if (qop) header += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  if (challenge.opaque) header += `, opaque="${challenge.opaque}"`;
  return header;
}

function create(ctx) {
  const host = ctx.config.connection.host;
  const port = ctx.config.connection.port || 80;
  const base = `http://${host}:${port}`;

  async function cgi(path) {
    const { username, password } = ctx.config.settings;
    let res = await fetch(`${base}${path}`);
    if (res.status === 401 && username) {
      const wwwAuth = res.headers.get("www-authenticate") || "";
      if (/^Digest/i.test(wwwAuth)) {
        const challenge = parseDigestChallenge(wwwAuth.replace(/^Digest\s+/i, ""));
        const authHeader = buildDigestHeader(challenge, "GET", path, username, password || "");
        res = await fetch(`${base}${path}`, { headers: { Authorization: authHeader } });
      } else {
        res = await fetch(`${base}${path}`, { headers: { Authorization: `Basic ${Buffer.from(`${username}:${password || ""}`).toString("base64")}` } });
      }
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }

  ctx.onAction("ptzMove", async ({ direction }) => {
    const channel = ctx.config.settings.channel || 1;
    try {
      await cgi(`/cgi-bin/ptz.cgi?action=start&channel=${channel}&code=${direction}&arg1=0&arg2=1&arg3=0`);
    } catch (err) {
      ctx.log(`ptzMove failed: ${err.message}`);
    }
  });
  ctx.onAction("ptzStop", async ({ direction }) => {
    const channel = ctx.config.settings.channel || 1;
    try {
      await cgi(`/cgi-bin/ptz.cgi?action=stop&channel=${channel}&code=${direction || "Up"}&arg1=0&arg2=1&arg3=0`);
    } catch (err) {
      ctx.log(`ptzStop failed: ${err.message}`);
    }
  });
  ctx.onAction("reboot", async () => {
    try {
      await cgi("/cgi-bin/magicBox.cgi?action=reboot");
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
