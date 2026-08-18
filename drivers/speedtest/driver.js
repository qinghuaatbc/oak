"use strict";
// Internet speed test driver - shells out to Ookla's own official
// `speedtest` CLI (speedtest.net/apps/cli, NOT the unrelated
// `speedtest-cli` Python package, which has a different flag/output
// shape) using execFile with an argument array (never a shell string,
// so this is not shell-injectable). Requires the CLI to already be
// installed on the host - this driver doesn't attempt to install it,
// and reports a clear error via ctx.log if the binary isn't found rather
// than failing silently.
const { execFile } = require("child_process");

function runSpeedtest() {
  return new Promise((resolve, reject) => {
    execFile("speedtest", ["--accept-license", "--accept-gdpr", "-f", "json"], { timeout: 120000 }, (err, stdout) => {
      if (err) {
        reject(new Error(err.code === "ENOENT" ? "speedtest CLI not found - install it from speedtest.net/apps/cli first" : err.message));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (parseErr) {
        reject(parseErr);
      }
    });
  });
}

function create(ctx) {
  let pollHandle = null;

  async function runTest() {
    try {
      const result = await runSpeedtest();
      const downloadMbps = (result.download.bandwidth * 8) / 1_000_000;
      const uploadMbps = (result.upload.bandwidth * 8) / 1_000_000;
      const pingMs = result.ping.latency;
      ctx.setState("speed.downloadMbps", Math.round(downloadMbps * 100) / 100);
      ctx.setState("speed.uploadMbps", Math.round(uploadMbps * 100) / 100);
      ctx.setState("speed.pingMs", Math.round(pingMs * 10) / 10);
      ctx.setState("speed.lastRunAt", new Date().toISOString());
      ctx.emitEvent("testComplete", { downloadMbps, uploadMbps, pingMs });
    } catch (err) {
      ctx.log(`Speed test failed: ${err.message}`);
    }
  }
  ctx.onAction("runTest", () => runTest());

  return {
    onConnect() {
      const intervalMinutes = Number(ctx.config.settings.intervalMinutes) || 0;
      if (intervalMinutes > 0) pollHandle = ctx.clock.every(intervalMinutes * 60000, runTest);
    },
    onDisconnect() {
      if (pollHandle) pollHandle.cancel();
    },
  };
}

module.exports = { create };
