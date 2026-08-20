"use strict";
// Somfy TaHoma / Overkiz driver over the cloud API (works across every
// Overkiz-based rebrand's cloud endpoint, unlike the local Developer-Mode
// API which is Somfy/Rexel-hub-only and needs manual enablement per
// gateway) - HIGH confidence on the exec/apply command shape, verified
// against pyoverkiz (the library behind Home Assistant's Overkiz
// integration). MODERATE confidence specifically on the login request's
// content type: implemented here as form-urlencoded, matching Overkiz's
// long-standing convention for this one endpoint even though the rest of
// the API is JSON - if login fails, this is the first thing to check
// against a current pyoverkiz auth trace.
//
// Command execution is asynchronous on Overkiz's side (the server
// returns an exec_id and completion arrives via a separate event
// listener this driver doesn't implement) - this driver fires commands
// and doesn't wait for/confirm completion, matching how most other
// fire-and-forget actions in this project already work.
function create(ctx) {
  let sessionCookie = null;

  function apiUrl(path) {
    return `https://${ctx.config.connection.endpoint}/enduser-mobile-web/enduserAPI${path}`;
  }

  async function login() {
    const { username, password } = ctx.config.settings;
    const res = await fetch(apiUrl("/login"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ userId: username || "", userPassword: password || "" }).toString(),
    });
    const setCookie = res.headers.get("set-cookie");
    if (!res.ok || !setCookie) return false;
    sessionCookie = setCookie.split(";")[0];
    return true;
  }

  async function execCommand(name, parameters) {
    try {
      if (!sessionCookie && !(await login())) {
        ctx.log("Login failed - check TaHoma account credentials");
        return;
      }
      const body = {
        label: "Oak command",
        actions: [{ deviceURL: ctx.config.settings.deviceUrl, commands: [{ name, parameters: parameters || [] }] }],
      };
      const res = await fetch(apiUrl("/exec/apply"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: sessionCookie },
        body: JSON.stringify(body),
      });
      if (res.status === 401) {
        sessionCookie = null;
        if (await login()) return execCommand(name, parameters);
      }
    } catch (err) {
      ctx.log(`${name} failed: ${err.message}`);
    }
  }

  ctx.onAction("open", () => execCommand("open"));
  ctx.onAction("close", () => execCommand("close"));
  ctx.onAction("stop", () => execCommand("stop"));
  ctx.onAction("setPosition", ({ position }) => execCommand("setClosure", [Math.max(0, Math.min(100, position))]));

  return {
    onConnect() {},
    onDisconnect() {},
  };
}

module.exports = { create };
