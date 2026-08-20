"use strict";
// Dahua camera/NVR/VTO-intercom driver over Dahua's own CGI-based HTTP
// API - HIGH confidence on the endpoints and digest-auth flow, verified
// against rroller/dahua (a ~2k-star, actively-maintained Home Assistant
// integration) plus multiple independent community sources. Digest auth
// reuses the exact RFC 2617 implementation already proven in
// ../hikvision (same standard, non-vendor-specific protocol - fetch()
// has no built-in Digest support, hence the hand-rolled challenge/
// response). Amcrest cameras are rebadged Dahua firmware, so this same
// digest-auth code is already shared across ../amcrest too.
//
// openDoor uses accessControl.cgi - the SAME endpoint for both an NVR's
// access-control relay AND a VTO intercom's door release (confirmed via
// a real production debug log, not just a doc). One real quirk from
// that same log: the device can return HTTP 400 even though the door
// still physically opens - this driver treats a 400 whose body looks
// like a normal CGI "OK" response as success too, rather than failing
// loudly on a status code alone.
//
// Event/alarm stream (motion, VTO ring) uses eventManager.cgi's
// long-lived multipart HTTP response - same "persistent GET, parse text
// lines out of the stream, reconnect on drop" shape already used in
// ../doorbird's monitor.cgi loop. The VTO ring event specifically
// (Code=BackKeyLight) is MEDIUM confidence only - community reverse-
// engineered, no official Dahua doc confirms the exact State-number
// meaning, and it may vary by VTO model/firmware - so this driver emits
// the raw parsed fields on the "ring" event rather than trying to
// collapse them into a guessed boolean, and Codes outside the
// known/confirmed set are passed through on "alarmEvent" rather than
// silently dropped.
//
// Deliberately NOT implemented: a second, entirely separate proprietary
// binary protocol some VTO models expose on raw TCP port 5000 for
// lower-latency ring detection - undocumented by Dahua, fully
// community-reverse-engineered, and model/firmware-dependent. Start with
// this driver's eventManager.cgi path; only worth investing in the
// port-5000 protocol if a specific real VTO proves unreliable with this.
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

  async function cgi(path, opts) {
    const { username, password } = ctx.config.settings;
    let res = await fetch(`${base}${path}`, opts);
    if (res.status === 401 && username) {
      const wwwAuth = res.headers.get("www-authenticate") || "";
      const challenge = parseDigestChallenge(wwwAuth.replace(/^Digest\s+/i, ""));
      const authHeader = buildDigestHeader(challenge, (opts && opts.method) || "GET", path, username, password || "");
      res = await fetch(`${base}${path}`, { ...opts, headers: { ...(opts && opts.headers), Authorization: authHeader } });
    }
    const body = await res.text();
    // Real quirk: a 400 can still mean the action succeeded - only treat
    // it as a failure if the body doesn't look like Dahua's own "OK".
    if (!res.ok && !(res.status === 400 && /^OK/i.test(body.trim()))) throw new Error(`HTTP ${res.status}`);
    return body;
  }

  function channel() {
    return ctx.config.settings.channel || 1;
  }

  ctx.onAction("openDoor", async () => {
    try {
      await cgi(`/cgi-bin/accessControl.cgi?action=openDoor&channel=${channel()}&UserID=101&Type=Remote`);
    } catch (err) {
      ctx.log(`openDoor failed: ${err.message}`);
    }
  });
  ctx.onAction("ptzStart", async ({ code, speed = 4 }) => {
    try {
      await cgi(`/cgi-bin/ptz.cgi?action=start&channel=${channel()}&code=${code}&arg1=0&arg2=${speed}&arg3=0`);
    } catch (err) {
      ctx.log(`ptzStart failed: ${err.message}`);
    }
  });
  ctx.onAction("ptzStop", async ({ code }) => {
    try {
      await cgi(`/cgi-bin/ptz.cgi?action=stop&channel=${channel()}&code=${code}&arg1=0&arg2=0&arg3=0`);
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

  let monitoring = false;

  function parseEventLine(line) {
    // "Code=VideoMotion;action=Start;index=0" - semicolon-separated
    // key=value pairs, no fixed schema across event types.
    const out = {};
    for (const part of line.split(";")) {
      const idx = part.indexOf("=");
      if (idx === -1) continue;
      out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    }
    return out;
  }

  async function monitorLoop() {
    while (monitoring) {
      try {
        const { username, password } = ctx.config.settings;
        const url = `${base}/cgi-bin/eventManager.cgi?action=attach&codes=[All]&heartbeat=5`;
        let res = await fetch(url);
        if (res.status === 401 && username) {
          const wwwAuth = res.headers.get("www-authenticate") || "";
          const challenge = parseDigestChallenge(wwwAuth.replace(/^Digest\s+/i, ""));
          const authHeader = buildDigestHeader(challenge, "GET", "/cgi-bin/eventManager.cgi?action=attach&codes=[All]&heartbeat=5", username, password || "");
          res = await fetch(url, { headers: { Authorization: authHeader } });
        }
        if (!res.ok || !res.body) throw new Error(`eventManager.cgi returned ${res.status}`);
        let buffered = "";
        for await (const chunk of res.body) {
          if (!monitoring) return;
          buffered += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
          let idx;
          while ((idx = buffered.indexOf("\n")) !== -1) {
            const line = buffered.slice(0, idx).trim();
            buffered = buffered.slice(idx + 1);
            if (!line.startsWith("Code=")) continue;
            const fields = parseEventLine(line);
            if (fields.Code === "VideoMotion") ctx.emitEvent("motion", { action: fields.action });
            else if (fields.Code === "BackKeyLight") ctx.emitEvent("ring", fields);
            else ctx.emitEvent("alarmEvent", fields);
          }
        }
      } catch (err) {
        ctx.log(`event stream error: ${err.message}`);
      }
      if (monitoring) await new Promise((resolve) => ctx.clock.after(3000, resolve));
    }
  }

  return {
    onConnect() {
      monitoring = true;
      monitorLoop();
    },
    onDisconnect() {
      monitoring = false;
    },
  };
}

module.exports = { create };
