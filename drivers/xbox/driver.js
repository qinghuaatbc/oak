"use strict";
// Xbox driver over the Xbox Live cloud REST API - NOT the local
// SmartGlass UDP/encrypted-TCP protocol (deliberately out of scope: that
// protocol needs its own RSA/AES pairing handshake, the same "wrong byte
// fails completely" risk profile that made this project skip an Apple TV
// driver - see ../nest's sibling commit message). The cloud path is
// better-trodden (Microsoft's own Xbox app uses it; xbox-webapi/openxbl
// document the flow) but still genuinely unofficial and involves an
// unusual multi-hop auth exchange Microsoft requires for Xbox Live
// specifically, not just plain OAuth2:
//   1. Standard OAuth2 refresh -> a Microsoft "live.com" access token.
//   2. Exchange that for an Xbox Live "user token" (xboxlive.com/user/authenticate).
//   3. Exchange the user token for an "XSTS token" (xsts.auth.xboxlive.com/xsts/authorize).
// The XSTS token (not the raw OAuth token) is what authorizes calls to
// xccs.xboxlive.com. Moderate confidence on this exchange - it's well
// documented by community libraries but has more moving parts than this
// project's other OAuth2 drivers.
const MS_TOKEN_URL = "https://login.live.com/oauth20_token.srf";
const XBL_AUTH_URL = "https://user.auth.xboxlive.com/user/authenticate";
const XSTS_AUTH_URL = "https://xsts.auth.xboxlive.com/xsts/authorize";
const XCCS_BASE = "https://xccs.xboxlive.com";

function create(ctx) {
  let xstsToken = null;
  let userHash = null;

  async function authenticate() {
    const { clientId, clientSecret, refreshToken } = ctx.config.settings;
    if (!refreshToken) return false;
    const tokenRes = await fetch(MS_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret, scope: "Xboxlive.signin Xboxlive.offline_access" }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      ctx.log(`Microsoft token refresh failed: ${tokenData.error_description || tokenRes.status}`);
      return false;
    }

    const xblRes = await fetch(XBL_AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-xbl-contract-version": "1" },
      body: JSON.stringify({ RelyingParty: "http://auth.xboxlive.com", TokenType: "JWT", Properties: { AuthMethod: "RPS", SiteName: "user.auth.xboxlive.com", RpsTicket: `d=${tokenData.access_token}` } }),
    });
    const xblData = await xblRes.json();
    if (!xblRes.ok) {
      ctx.log(`Xbox Live user auth failed: HTTP ${xblRes.status}`);
      return false;
    }

    const xstsRes = await fetch(XSTS_AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-xbl-contract-version": "1" },
      body: JSON.stringify({ RelyingParty: "http://xboxlive.com", TokenType: "JWT", Properties: { UserTokens: [xblData.Token], SandboxId: "RETAIL" } }),
    });
    const xstsData = await xstsRes.json();
    if (!xstsRes.ok) {
      ctx.log(`XSTS auth failed: HTTP ${xstsRes.status}`);
      return false;
    }
    xstsToken = xstsData.Token;
    userHash = xstsData.DisplayClaims.xui[0].uhs;
    return true;
  }

  async function api(path, opts) {
    if (!xstsToken && !(await authenticate())) return null;
    const res = await fetch(`${XCCS_BASE}${path}`, {
      ...opts,
      headers: { Authorization: `XBL3.0 x=${userHash};${xstsToken}`, "Content-Type": "application/json", "x-xbl-contract-version": "4", ...(opts && opts.headers) },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.status === 204 ? null : res.json();
  }

  ctx.onAction("turnOn", async () => {
    const consoleId = ctx.config.settings.consoleId;
    try {
      await api(`/consoles/${consoleId}/power`, { method: "POST", body: JSON.stringify({ intent: "PowerOn" }) });
    } catch (err) {
      ctx.log(`turnOn failed: ${err.message}`);
    }
  });
  ctx.onAction("turnOff", async () => {
    const consoleId = ctx.config.settings.consoleId;
    try {
      await api(`/consoles/${consoleId}/power`, { method: "POST", body: JSON.stringify({ intent: "PowerOff" }) });
    } catch (err) {
      ctx.log(`turnOff failed: ${err.message}`);
    }
  });
  ctx.onAction("discoverConsoles", async () => {
    try {
      const data = await api("/lists/devices");
      const consoles = (data.result || []).map((c) => ({ id: c.id, name: c.name }));
      ctx.setState("discovery.consoles", JSON.stringify(consoles));
    } catch (err) {
      ctx.log(`discoverConsoles failed: ${err.message}`);
    }
  });

  return {
    onConnect() {},
    onDisconnect() {},
  };
}

module.exports = { create };
