"use strict";
// Plex Media Server driver over Plex's own local HTTP API. Plex doesn't
// publish a formal spec, but the X-Plex-Token auth mechanism and this
// endpoint shape have been stable and consistently documented across the
// community (python-plexapi, years of forum/wiki documentation) for long
// enough that this is written with real confidence, not a guess.
//
// Playback commands target a specific CLIENT (a Plex app instance - Roku,
// Apple TV, another Plex Media Player, etc.) by machine identifier, sent
// to the SERVER with an X-Plex-Target-Client-Identifier header - the
// server relays it to the actual client over the local network (Plex's
// own GDM discovery mechanism), so this driver only ever talks to the
// server, never the client device directly.
const POLL_MS = 10000;

function create(ctx) {
  const host = ctx.config.connection.host;
  const port = ctx.config.connection.port || 32400;
  const base = `http://${host}:${port}`;

  let pollHandle = null;

  function headers(extra) {
    return { "X-Plex-Token": ctx.config.settings.token || "", "X-Plex-Client-Identifier": "oak-orchestrator", Accept: "application/json", ...extra };
  }
  async function command(path) {
    try {
      await fetch(`${base}${path}`, { headers: headers({ "X-Plex-Target-Client-Identifier": ctx.config.settings.clientIdentifier || "" }) });
      refresh();
    } catch (err) {
      ctx.log(`Command failed: ${err.message}`);
    }
  }

  ctx.onAction("play", () => command("/player/playback/play"));
  ctx.onAction("pause", () => command("/player/playback/pause"));
  ctx.onAction("stop", () => command("/player/playback/stop"));
  ctx.onAction("skipNext", () => command("/player/playback/skipNext"));
  ctx.onAction("skipPrevious", () => command("/player/playback/skipPrevious"));

  ctx.onAction("discoverClients", async () => {
    try {
      const res = await fetch(`${base}/clients`, { headers: headers() });
      const data = await res.json();
      const clients = ((data.MediaContainer && data.MediaContainer.Server) || []).map((c) => ({ id: c.machineIdentifier, name: c.name, product: c.product }));
      ctx.setState("discovery.clients", JSON.stringify(clients));
    } catch (err) {
      ctx.log(`Discovery failed: ${err.message}`);
    }
  });

  async function refresh() {
    try {
      const res = await fetch(`${base}/status/sessions`, { headers: headers() });
      const data = await res.json();
      const sessions = (data.MediaContainer && data.MediaContainer.Metadata) || [];
      const session = sessions[0];
      ctx.setState("session.playing", Boolean(session && session.Player && session.Player.state === "playing"));
      if (session) ctx.setState("session.title", session.title);
    } catch (err) {
      ctx.log(`Refresh failed: ${err.message}`);
    }
  }
  ctx.onAction("refresh", () => refresh());

  return {
    onConnect() {
      refresh();
      pollHandle = ctx.clock.every(POLL_MS, refresh);
    },
    onDisconnect() {
      if (pollHandle) pollHandle.cancel();
    },
  };
}

module.exports = { create };
