"use strict";
// Generic SSH/CLI driver - runs an arbitrary shell command on any
// SSH-reachable host (a Linux server, a NAS, a router/switch whose only
// management surface is a CLI, a custom automation script on a home
// server, etc). Uses the real `ssh2` npm package rather than hand-rolling
// the protocol - unlike the AES/digest-auth/SNMP primitives hand-rolled
// elsewhere in this project, SSH's key exchange/cipher negotiation/host-
// key verification is genuinely too large and too security-critical to
// reimplement safely by hand; this is the one deliberate exception to
// this project's usual "implement the protocol yourself" approach.
//
// SECURITY, READ THIS BEFORE USING: this driver can run ANY command the
// configured account can run on the target host - it is a general-
// purpose remote-code-execution primitive by design, not a narrow
// device-control surface like every other driver in this project. This
// meaningfully raises the stakes of Oak's own current lack of API
// authentication (a known, deliberately-deferred gap - see this
// project's own security review): without auth in front of the
// orchestrator, anyone who can reach it could use a configured instance
// of this driver to run arbitrary commands on whatever host it's pointed
// at. Only add this driver pointed at hosts/accounts you'd be fine with
// anyone who can reach your Oak instance controlling.
//
// Deliberately connects PER COMMAND rather than holding a persistent SSH
// session open (onConnect below does nothing) - a command here is a
// rare, human/automation-paced action, not a high-frequency one, and
// this project's own experience today with persistent-connection
// fragility (eisy's WS/GENA event stream silently going stale) is a
// good reason not to add another long-lived connection that needs its
// own health-monitoring when a fresh connection per command is simpler
// and has no staleness failure mode to begin with.
const { Client } = require("ssh2");

function runOnce(ctx, command) {
  return new Promise((resolve, reject) => {
    const { username, password, privateKey, passphrase, timeoutMs } = ctx.config.settings;
    const connectConfig = {
      host: ctx.config.connection.host,
      port: ctx.config.connection.port || 22,
      username,
      readyTimeout: Number(timeoutMs) || 10000,
    };
    if (privateKey) {
      connectConfig.privateKey = privateKey;
      if (passphrase) connectConfig.passphrase = passphrase;
    } else {
      connectConfig.password = password || "";
    }
    const conn = new Client();
    conn.on("ready", () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          conn.end();
          reject(err);
          return;
        }
        let stdout = "";
        let stderr = "";
        stream.on("data", (data) => {
          stdout += data.toString("utf8");
        });
        stream.stderr.on("data", (data) => {
          stderr += data.toString("utf8");
        });
        stream.on("close", (code) => {
          conn.end();
          resolve({ code, stdout, stderr });
        });
      });
    });
    conn.on("error", reject);
    conn.connect(connectConfig);
  });
}

function create(ctx) {
  ctx.onAction("runCommand", async ({ command }) => {
    try {
      const { code, stdout, stderr } = await runOnce(ctx, command);
      ctx.setState("lastCommand", command);
      ctx.setState("lastExitCode", code);
      ctx.setState("lastOutput", stdout.slice(-4000)); // capped - this is a status readout, not a log viewer
      ctx.setState("lastError", stderr.slice(-4000));
      ctx.emitEvent("commandCompleted", { command, code });
    } catch (err) {
      ctx.log(`runCommand failed: ${err.message}`);
      ctx.setState("lastError", err.message);
    }
  });

  return {
    onConnect() {}, // no persistent session - see header comment
    onDisconnect() {},
  };
}

module.exports = { create };
