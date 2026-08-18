"use strict";
// Emporia Vue energy monitor driver over their UNOFFICIAL cloud API
// (documented by the pyemvue community library). LOWER confidence than
// most drivers here: auth goes through AWS Cognito's own real,
// documented InitiateAuth API (a genuine AWS service, not Emporia-
// specific), but the exact Cognito App Client ID Emporia's app uses is
// recalled with only moderate confidence and could be wrong or rotated -
// same risk class as ../meross's embedded app secret. A wrong ClientId
// surfaces as a clean Cognito auth error (logged), not a hang.
const COGNITO_URL = "https://cognito-idp.us-east-2.amazonaws.com/";
const COGNITO_CLIENT_ID = "4qte47jbstod8apnfic0bunmrq"; // Emporia's own app's Cognito client id, per pyemvue
const API_BASE = "https://api.emporiaenergy.com";
const POLL_MS = 60000;

function create(ctx) {
  let idToken = null;
  let pollHandle = null;

  ctx.onAction("login", async () => {
    try {
      const res = await fetch(COGNITO_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-amz-json-1.1", "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth" },
        body: JSON.stringify({ AuthFlow: "USER_PASSWORD_AUTH", ClientId: COGNITO_CLIENT_ID, AuthParameters: { USERNAME: ctx.config.settings.email, PASSWORD: ctx.config.settings.password } }),
      });
      const data = await res.json();
      idToken = data.AuthenticationResult && data.AuthenticationResult.IdToken;
      if (idToken) ctx.log("Logged in");
      else ctx.log(`Login failed: ${JSON.stringify(data)}`);
    } catch (err) {
      ctx.log(`Login failed: ${err.message}`);
    }
  });

  async function refresh() {
    const deviceGid = ctx.config.settings.deviceGid;
    if (!idToken || !deviceGid) return;
    try {
      const data = await fetch(`${API_BASE}/AppAPI?apiMethod=getDeviceListUsages&deviceGids=${deviceGid}&instant=${new Date().toISOString()}&scale=1MIN&energyUnit=KilowattHours`, {
        headers: { authtoken: idToken },
      }).then((r) => r.json());
      const device = data.deviceListUsages && data.deviceListUsages.devices && data.deviceListUsages.devices[0];
      const usageKwh = device && device.channelUsages && device.channelUsages[0] && device.channelUsages[0].usage;
      if (usageKwh !== undefined) ctx.setState("power.usageWatts", usageKwh * 60000); // 1-min kWh -> instantaneous W
    } catch (err) {
      ctx.log(`Refresh failed: ${err.message}`);
    }
  }
  ctx.onAction("refresh", () => refresh());

  return {
    onConnect() {
      pollHandle = ctx.clock.every(POLL_MS, refresh);
    },
    onDisconnect() {
      if (pollHandle) pollHandle.cancel();
    },
  };
}

module.exports = { create };
