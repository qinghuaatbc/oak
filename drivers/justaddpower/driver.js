"use strict";
// Just Add Power AV-over-IP decoder driver - HIGH confidence on both
// paths, sourced directly from Just Add Power's own support KB: the
// port-80 `/cgi-bin/api/command/channel` HTTP API (Unified Mode,
// justOS B2.1.0+) and the port-23 Telnet CLI `channel -v/-a <n>`
// commands (Flexible Mode, the default under AMP v1.6.0 configs).
//
// This mode split is a real, documented gotcha, not a design choice
// this driver invented: the HTTP API explicitly does NOT work in
// Flexible Mode, and an installation could genuinely be running either
// mode - hence the connection "choice" between the two in the manifest,
// with this driver picking its behavior based on which one was
// configured (ctx.connection is only non-null for the Telnet/TCP option).
function create(ctx) {
  function isTelnetMode() {
    return Boolean(ctx.connection);
  }

  async function setUnifiedChannel(channel) {
    try {
      const res = await fetch(`http://${ctx.config.connection.host}/cgi-bin/api/command/channel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cmd: "set", channel }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      ctx.log(`setChannel failed: ${err.message}`);
    }
  }

  ctx.onAction("setChannel", ({ channel }) => {
    if (isTelnetMode()) ctx.connection.send(`channel -v ${channel}\r`);
    else setUnifiedChannel(channel);
  });
  ctx.onAction("setAudioChannel", ({ channel }) => {
    if (isTelnetMode()) ctx.connection.send(`channel -a ${channel}\r`);
    else ctx.log("setAudioChannel is only available in Flexible Mode (Telnet) - Unified Mode's HTTP API only exposes a single combined channel");
  });

  return {
    onConnect() {},
    onDisconnect() {},
    onData() {},
  };
}

module.exports = { create };
