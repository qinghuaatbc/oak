"use strict";
// August smart lock driver over August's UNOFFICIAL private API - like
// ../ring and ../myq, this is in the least-reliable class of driver in
// this project: no public API, reverse-engineered (community projects
// like yalexs document this login/verification flow). Login requires an
// interactive SMS/email verification code step (August's own 2FA-style
// flow, not something this driver can skip) - login() triggers the code
// to be sent, then completeLogin() (after filling in verificationCode)
// finishes authenticating, same two-step pattern as ../ring's 2FA flow.
const API_BASE = "https://api-production.august.com";
const POLL_MS = 60000;

function create(ctx) {
  let accessToken = null;
  let pollHandle = null;

  function appHeaders(extra) {
    // The api-key value below is the shared, publicly-known constant the
    // official August mobile app itself sends on every request (not a
    // per-user secret) - recalled from community reverse-engineering
    // (yalexs), lowest-confidence single value in this file since August
    // could rotate it without notice.
    return {
      "Content-Type": "application/json",
      "x-august-api-key": "79fd0eb6-381d-4adf-95a0-47721289d1d9",
      "x-kease-api-key": "79fd0eb6-381d-4adf-95a0-47721289d1d9",
      ...(accessToken ? { "x-august-access-token": accessToken } : {}),
      ...extra,
    };
  }

  ctx.onAction("login", async () => {
    try {
      const res = await fetch(`${API_BASE}/session`, {
        method: "POST",
        headers: appHeaders(),
        body: JSON.stringify({ identifier: ctx.config.settings.identifier, password: ctx.config.settings.password, installId: "oak" }),
      });
      accessToken = res.headers.get("x-august-access-token");
      const isPhone = (ctx.config.settings.identifier || "").startsWith("phone:");
      await fetch(`${API_BASE}/validation/${isPhone ? "phone" : "email"}`, { method: "POST", headers: appHeaders(), body: JSON.stringify({ value: (ctx.config.settings.identifier || "").split(":")[1] }) });
      ctx.log("Verification code sent - fill in verificationCode and run completeLogin");
      ctx.emitEvent("verificationRequired", {});
    } catch (err) {
      ctx.log(`Login failed: ${err.message}`);
    }
  });

  ctx.onAction("completeLogin", async () => {
    const isPhone = (ctx.config.settings.identifier || "").startsWith("phone:");
    try {
      await fetch(`${API_BASE}/validate/${isPhone ? "phone" : "email"}`, {
        method: "POST",
        headers: appHeaders(),
        body: JSON.stringify({ value: (ctx.config.settings.identifier || "").split(":")[1], code: ctx.config.settings.verificationCode }),
      });
      const res = await fetch(`${API_BASE}/session`, {
        method: "POST",
        headers: appHeaders(),
        body: JSON.stringify({ identifier: ctx.config.settings.identifier, password: ctx.config.settings.password, installId: "oak" }),
      });
      accessToken = res.headers.get("x-august-access-token");
      if (accessToken) {
        ctx.log("Logged in");
        ctx.emitEvent("loggedIn", {});
      } else {
        ctx.log("Login not confirmed - check the verification code");
      }
    } catch (err) {
      ctx.log(`completeLogin failed: ${err.message}`);
    }
  });

  async function lockAction(action) {
    const lockId = ctx.config.settings.lockId;
    try {
      await fetch(`${API_BASE}/remoteoperate/${lockId}/${action}`, { method: "PUT", headers: appHeaders() });
      refresh();
    } catch (err) {
      ctx.log(`${action} failed: ${err.message}`);
    }
  }
  ctx.onAction("lock", () => lockAction("lock"));
  ctx.onAction("unlock", () => lockAction("unlock"));

  ctx.onAction("discoverLocks", async () => {
    try {
      const data = await fetch(`${API_BASE}/users/locks/mine`, { headers: appHeaders() }).then((r) => r.json());
      const locks = Object.entries(data || {}).map(([id, l]) => ({ id, name: l.LockName }));
      ctx.setState("discovery.locks", JSON.stringify(locks));
    } catch (err) {
      ctx.log(`discoverLocks failed: ${err.message}`);
    }
  });

  async function refresh() {
    const lockId = ctx.config.settings.lockId;
    if (!lockId || !accessToken) return;
    try {
      const data = await fetch(`${API_BASE}/locks/${lockId}/status`, { headers: appHeaders() }).then((r) => r.json());
      if (data.status) ctx.setState("lock.locked", data.status === "kAugLockState_Locked");
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
