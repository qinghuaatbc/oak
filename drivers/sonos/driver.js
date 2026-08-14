"use strict";
// Sonos driver over the speaker's own local UPnP/SOAP control API (port
// 1400, unchanged and stable for well over a decade - Sonos's real
// published control surface, not a third-party project's reverse-
// engineering of it). One instance per physical speaker/zone, matching
// http-relay's "one instance per device" convention - Sonos zone grouping/
// coordination is a real, more advanced feature deliberately out of scope
// here. No XML parser available in the driver sandbox (same constraint
// eisy's driver already works within) - response fields are pulled out
// with a small regex helper, not a full parse.
function create(ctx) {
  const host = ctx.config.connection.host;
  const port = ctx.config.connection.port || 1400;
  const baseUrl = `http://${host}:${port}`;
  let pollHandle = null;
  let lastSnapshot = null;

  function xmlTag(xml, tag) {
    const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
    return m ? m[1] : undefined;
  }

  async function soap(servicePath, serviceType, action, argsXml) {
    const body =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
      `<s:Body><u:${action} xmlns:u="${serviceType}">${argsXml || ""}</u:${action}></s:Body></s:Envelope>`;
    const res = await fetch(`${baseUrl}${servicePath}`, {
      method: "POST",
      headers: {
        "Content-Type": 'text/xml; charset="utf-8"',
        SOAPACTION: `"${serviceType}#${action}"`,
      },
      body,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${action} failed: HTTP ${res.status} - ${xmlTag(text, "errorDescription") || text.slice(0, 200)}`);
    return text;
  }
  const avTransport = (action, args) => soap("/MediaRenderer/AVTransport/Control", "urn:schemas-upnp-org:service:AVTransport:1", action, args);
  const renderingControl = (action, args) => soap("/MediaRenderer/RenderingControl/Control", "urn:schemas-upnp-org:service:RenderingControl:1", action, args);
  const INSTANCE_ARGS = "<InstanceID>0</InstanceID>";

  async function fetchStatus() {
    try {
      const [transportXml, volumeXml, muteXml] = await Promise.all([
        avTransport("GetTransportInfo", INSTANCE_ARGS),
        renderingControl("GetVolume", `${INSTANCE_ARGS}<Channel>Master</Channel>`),
        renderingControl("GetMute", `${INSTANCE_ARGS}<Channel>Master</Channel>`),
      ]);
      const transportState = xmlTag(transportXml, "CurrentTransportState") || "STOPPED";
      const volume = Number(xmlTag(volumeXml, "CurrentVolume")) || 0;
      const muted = xmlTag(muteXml, "CurrentMute") === "1";
      const snapshot = `${transportState}:${volume}:${muted}`;
      if (snapshot === lastSnapshot) return;
      lastSnapshot = snapshot;
      ctx.setState("media.on", transportState === "PLAYING");
      ctx.setState("media.level", volume);
      ctx.setState("media.transportState", transportState);
      ctx.setState("media.muted", muted);
      ctx.emitEvent("stateChanged", { transportState, volume });
    } catch (err) {
      ctx.log("status poll failed:", err.message);
    }
  }

  ctx.onAction("play", async () => {
    try {
      await avTransport("Play", `${INSTANCE_ARGS}<Speed>1</Speed>`);
      await fetchStatus();
    } catch (err) {
      ctx.log("play failed:", err.message);
    }
  });
  ctx.onAction("pause", async () => {
    try {
      await avTransport("Pause", INSTANCE_ARGS);
      await fetchStatus();
    } catch (err) {
      ctx.log("pause failed:", err.message);
    }
  });
  ctx.onAction("next", async () => {
    try {
      await avTransport("Next", INSTANCE_ARGS);
    } catch (err) {
      ctx.log("next failed:", err.message);
    }
  });
  ctx.onAction("previous", async () => {
    try {
      await avTransport("Previous", INSTANCE_ARGS);
    } catch (err) {
      ctx.log("previous failed:", err.message);
    }
  });
  ctx.onAction("setVolume", async ({ level = 30 }) => {
    try {
      const vol = Math.max(0, Math.min(100, Math.round(level)));
      await renderingControl("SetVolume", `${INSTANCE_ARGS}<Channel>Master</Channel><DesiredVolume>${vol}</DesiredVolume>`);
      await fetchStatus();
    } catch (err) {
      ctx.log("setVolume failed:", err.message);
    }
  });
  ctx.onAction("mute", async () => {
    try {
      await renderingControl("SetMute", `${INSTANCE_ARGS}<Channel>Master</Channel><DesiredMute>1</DesiredMute>`);
      await fetchStatus();
    } catch (err) {
      ctx.log("mute failed:", err.message);
    }
  });
  ctx.onAction("unmute", async () => {
    try {
      await renderingControl("SetMute", `${INSTANCE_ARGS}<Channel>Master</Channel><DesiredMute>0</DesiredMute>`);
      await fetchStatus();
    } catch (err) {
      ctx.log("unmute failed:", err.message);
    }
  });

  return {
    onConnect() {
      ctx.log("Polling", baseUrl);
      fetchStatus();
      const intervalMs = (ctx.config.settings && ctx.config.settings.pollIntervalMs) || 5000;
      pollHandle = ctx.clock.every(intervalMs, fetchStatus);
    },
    onDisconnect() {
      if (pollHandle) pollHandle.cancel();
    },
  };
}
module.exports = { create };
