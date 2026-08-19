"use strict";
// WyreStorm NetworkHD driver over the NHD-CTL/NHD-000-CTL/NHD-IP-CTL
// central controller's Telnet ASCII API. MODERATE confidence: WyreStorm's
// NetworkHD command surface is NOT one uniform protocol across the
// encoder/decoder product lines (NHD-100/400/500/600 each differ) - this
// driver deliberately targets the one well-documented, consistent
// surface (the central controller's plain-text "matrix set" command),
// rather than trying to guess at any individual encoder/decoder's own
// command set. Anything beyond basic routing (video walls, USB
// switching, IR passthrough) is out of scope for this first cut.
function create(ctx) {
  ctx.onAction("route", ({ txAlias, rxAlias }) => {
    ctx.connection.send(`matrix set ${txAlias} ${rxAlias}\r\n`);
  });
  ctx.onAction("disconnect", ({ rxAlias }) => {
    ctx.connection.send(`matrix set NULL ${rxAlias}\r\n`);
  });

  return {
    onConnect() {},
    onDisconnect() {},
    onData() {},
  };
}

module.exports = { create };
