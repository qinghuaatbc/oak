"use strict";
// Twilio SMS driver over their own published REST API
// (twilio.com/docs/sms/api) - real, official, extensively documented,
// high confidence.
function create(ctx) {
  ctx.onAction("sendSms", async ({ message, to }) => {
    const { accountSid, authToken, fromNumber, toNumber } = ctx.config.settings;
    const recipient = to || toNumber;
    if (!accountSid || !authToken || !fromNumber || !recipient) {
      ctx.log("accountSid/authToken/fromNumber/recipient must all be set");
      return;
    }
    try {
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: recipient, From: fromNumber, Body: message || "" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      ctx.setState("last.sentAt", new Date().toISOString());
    } catch (err) {
      ctx.log(`sendSms failed: ${err.message}`);
    }
  });

  return {
    onConnect() {},
    onDisconnect() {},
  };
}

module.exports = { create };
