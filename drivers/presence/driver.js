"use strict";
// Presence detection via ICMP ping, shelling out to the system `ping`
// binary rather than opening a raw socket - Node has no ICMP support in
// core, and a raw ICMP socket needs root/CAP_NET_RAW on Linux (this
// orchestrator runs as an unprivileged systemd user, see
// scripts/install.sh), so the system ping binary (already
// setuid/capabilities-configured by the OS) is the practical path, not a
// shortcut. Uses execFile with an argument array (never a shell string),
// so this is not shell-injectable even though `host` is admin-configured
// rather than a hardcoded constant.
//
// Linux `ping` syntax specifically (-W in whole seconds) - this matches
// the actual deployment target (see scripts/install.sh's systemd unit);
// macOS/BSD ping's -W takes milliseconds instead, so this won't behave
// identically if Oak is ever run there, worth knowing rather than
// assuming portability that was never tested.
const { execFile } = require("child_process");

function pingOnce(host) {
  return new Promise((resolve) => {
    execFile("ping", ["-c", "1", "-W", "2", host], (err) => resolve(!err));
  });
}

function create(ctx) {
  let pollHandle = null;
  let lastHome = null;

  async function check() {
    const host = ctx.config.settings.host;
    if (!host) return;
    const home = await pingOnce(host);
    if (home !== lastHome) {
      lastHome = home;
      ctx.setState("presence.home", home);
      ctx.emitEvent(home ? "arrived" : "departed", {});
    }
  }

  ctx.onAction("checkNow", () => check());

  return {
    onConnect() {
      const intervalMs = Math.max(5, Number(ctx.config.settings.intervalSeconds) || 30) * 1000;
      check();
      pollHandle = ctx.clock.every(intervalMs, check);
    },
    onDisconnect() {
      if (pollHandle) pollHandle.cancel();
    },
  };
}

module.exports = { create };
