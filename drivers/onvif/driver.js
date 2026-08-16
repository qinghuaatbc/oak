"use strict";
// ONVIF camera driver - SOAP/XML over plain HTTP POST, against the
// published ONVIF Core Specification (an open industry standard, not
// reverse-engineered). WS-Security UsernameToken digest auth
// (PasswordDigest = Base64(SHA1(nonce + created + password))) is the
// standard WS-Security UsernameToken Profile 1.0 algorithm - high
// confidence, it's a fixed spec, not vendor-specific. PTZ/Media SOAP
// action shapes below match the ONVIF PTZ/Media service WSDLs. WS-
// Discovery (the UDP multicast "find cameras on my network" mechanism)
// is NOT implemented - this driver expects a manually-entered IP, same
// scope decision as every other local-network driver in Oak that skips
// discovery in favor of direct configuration.
//
// Not verified against a real ONVIF camera this session - camera
// firmware ONVIF compliance varies a lot in practice (a genuinely common
// complaint about this standard), so treat this as a starting point more
// than most.
const crypto = require("crypto");

function soapEnvelope(username, password, bodyXml) {
  const created = new Date().toISOString();
  const nonce = crypto.randomBytes(16);
  const digest = crypto
    .createHash("sha1")
    .update(Buffer.concat([nonce, Buffer.from(created, "utf8"), Buffer.from(password, "utf8")]))
    .digest("base64");
  const security = username
    ? `<Security xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
        <UsernameToken>
          <Username>${username}</Username>
          <Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</Password>
          <Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString("base64")}</Nonce>
          <Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${created}</Created>
        </UsernameToken>
      </Security>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">
  <s:Header>${security}</s:Header>
  <s:Body>${bodyXml}</s:Body>
</s:Envelope>`;
}

function extractTag(xml, tag) {
  const m = new RegExp(`<(?:\\w+:)?${tag}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`).exec(xml);
  return m ? m[1] : undefined;
}

function create(ctx) {
  const host = ctx.config.connection.host;
  const port = ctx.config.connection.port || 80;
  const username = ctx.config.settings.username || "";
  const password = ctx.config.settings.password || "";
  const deviceServiceUrl = `http://${host}:${port}/onvif/device_service`;

  async function soapCall(serviceUrl, bodyXml) {
    const res = await fetch(serviceUrl, {
      method: "POST",
      headers: { "Content-Type": "application/soap+xml; charset=utf-8" },
      body: soapEnvelope(username, password, bodyXml),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`ONVIF SOAP fault (HTTP ${res.status}): ${text.slice(0, 300)}`);
    return text;
  }

  // Media and PTZ services usually live at their own XAddr, discovered
  // via GetCapabilities - but most consumer cameras keep them at the
  // predictable /onvif/media_service and /onvif/ptz_service paths, used
  // directly here rather than doing a capabilities round-trip first.
  const mediaServiceUrl = `http://${host}:${port}/onvif/media_service`;
  const ptzServiceUrl = `http://${host}:${port}/onvif/ptz_service`;

  ctx.onAction("getStreamUri", async () => {
    try {
      const xml = await soapCall(
        mediaServiceUrl,
        `<GetStreamUri xmlns="http://www.onvif.org/ver10/media/wsdl">
          <StreamSetup>
            <Stream xmlns="http://www.onvif.org/ver10/schema">RTP-Unicast</Stream>
            <Transport xmlns="http://www.onvif.org/ver10/schema"><Protocol>RTSP</Protocol></Transport>
          </StreamSetup>
          <ProfileToken>${ctx.config.settings.profileToken || ""}</ProfileToken>
        </GetStreamUri>`
      );
      const uri = extractTag(xml, "Uri");
      if (uri) ctx.setState("stream.rtspUri", uri);
    } catch (err) {
      ctx.log(`getStreamUri failed: ${err.message}`);
    }
  });

  ctx.onAction("ptzMove", async ({ pan = 0, tilt = 0, zoom = 0 }) => {
    try {
      await soapCall(
        ptzServiceUrl,
        `<ContinuousMove xmlns="http://www.onvif.org/ver20/ptz/wsdl">
          <ProfileToken>${ctx.config.settings.profileToken || ""}</ProfileToken>
          <Velocity>
            <PanTilt xmlns="http://www.onvif.org/ver10/schema" x="${pan}" y="${tilt}"/>
            <Zoom xmlns="http://www.onvif.org/ver10/schema" x="${zoom}"/>
          </Velocity>
        </ContinuousMove>`
      );
    } catch (err) {
      ctx.log(`ptzMove failed: ${err.message}`);
    }
  });
  ctx.onAction("ptzStop", async () => {
    try {
      await soapCall(
        ptzServiceUrl,
        `<Stop xmlns="http://www.onvif.org/ver20/ptz/wsdl">
          <ProfileToken>${ctx.config.settings.profileToken || ""}</ProfileToken>
          <PanTilt>true</PanTilt>
          <Zoom>true</Zoom>
        </Stop>`
      );
    } catch (err) {
      ctx.log(`ptzStop failed: ${err.message}`);
    }
  });
  ctx.onAction("ptzGotoPreset", async ({ presetToken }) => {
    try {
      await soapCall(
        ptzServiceUrl,
        `<GotoPreset xmlns="http://www.onvif.org/ver20/ptz/wsdl">
          <ProfileToken>${ctx.config.settings.profileToken || ""}</ProfileToken>
          <PresetToken>${presetToken || ctx.config.settings.presetToken || ""}</PresetToken>
        </GotoPreset>`
      );
    } catch (err) {
      ctx.log(`ptzGotoPreset failed: ${err.message}`);
    }
  });

  return {
    onConnect() {
      ctx.log(`ONVIF driver ready for ${deviceServiceUrl}`);
    },
    onDisconnect() {},
  };
}

module.exports = { create };
