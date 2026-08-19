"use strict";
// DoorBird video intercom driver over its official LAN-2-LAN HTTP API -
// HIGH confidence: endpoints below are read directly from DoorBird's own
// published API PDF (rev 0.36), not reconstructed from memory.
//
// Ring/motion events use monitor.cgi's long-lived multipart HTTP stream
// (documented) rather than the UDP broadcast event mechanism (also
// documented, but ChaCha20-Poly1305-encrypted with a key fetched via a
// separate session endpoint) - monitor.cgi is simpler and sufficient for
// a control-focused driver. This is NOT a full multipart parser (the
// exact boundary framing isn't parsed) - it just scans the accumulated
// stream text for the documented "doorbell:H"/"motionsensor:H" state
// lines, which is sufficient since nothing else in the stream is used.
function create(ctx) {
  function authHeader() {
    const { username, password } = ctx.config.settings;
    return "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
  }
  function apiUrl(path) {
    return `http://${ctx.config.connection.host}${path}`;
  }

  ctx.onAction("openDoor", async ({ relay }) => {
    try {
      const qs = relay ? `?r=${encodeURIComponent(relay)}` : "";
      await fetch(apiUrl(`/bha-api/open-door.cgi${qs}`), { headers: { Authorization: authHeader() } });
    } catch (err) {
      ctx.log(`openDoor failed: ${err.message}`);
    }
  });
  ctx.onAction("lightOn", async () => {
    try {
      await fetch(apiUrl("/bha-api/light-on.cgi"), { headers: { Authorization: authHeader() } });
    } catch (err) {
      ctx.log(`lightOn failed: ${err.message}`);
    }
  });

  let monitoring = false;
  const lastFired = { doorbell: 0, motionsensor: 0 };
  const DEBOUNCE_MS = 2000;

  async function monitorLoop() {
    while (monitoring) {
      try {
        const res = await fetch(apiUrl("/bha-api/monitor.cgi?ring=doorbell,motionsensor"), { headers: { Authorization: authHeader() } });
        if (!res.ok || !res.body) throw new Error(`monitor.cgi returned ${res.status}`);
        let buffered = "";
        for await (const chunk of res.body) {
          if (!monitoring) return;
          buffered += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
          let idx;
          while ((idx = buffered.indexOf("\n")) !== -1) {
            const line = buffered.slice(0, idx).trim();
            buffered = buffered.slice(idx + 1);
            const m = line.match(/^(doorbell|motionsensor):H$/);
            if (m) {
              const key = m[1];
              const now = Date.now();
              if (now - lastFired[key] > DEBOUNCE_MS) {
                lastFired[key] = now;
                ctx.emitEvent(key === "doorbell" ? "ring" : "motion", {});
              }
            }
          }
        }
      } catch (err) {
        ctx.log(`monitor stream error: ${err.message}`);
      }
      // The sandbox's vm.Context does NOT expose the raw setTimeout global
      // (only ctx.clock.every/after are provided - see runtime/loader.js's
      // sandbox object) - a bare setTimeout() here throws ReferenceError.
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
