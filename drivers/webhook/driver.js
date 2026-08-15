"use strict";
// Generic outbound webhook driver - calls any URL with any method/headers/
// body, so Automation/Macro can reach a REST API Oak has no dedicated
// driver for yet. Deliberately unopinionated (unlike every other driver
// in this project, which speaks one real, specific service's API) - this
// is Oak's escape hatch, matching the role Home Assistant's own generic
// rest_command integration plays there.
function create(ctx) {
  ctx.onAction("call", async ({ url, method, headers, body }) => {
    if (!url) {
      ctx.log("call: url is required");
      return;
    }
    let parsedHeaders = {};
    if (headers) {
      try {
        parsedHeaders = JSON.parse(headers);
      } catch (err) {
        ctx.log("call: headers isn't valid JSON:", err.message);
        return;
      }
    }
    // If the body looks like JSON and the caller didn't already set their
    // own Content-Type, default to application/json - the common case
    // (posting a JSON payload to a webhook) shouldn't require typing the
    // header out by hand every time, but an explicit header always wins.
    const hasContentType = Object.keys(parsedHeaders).some((k) => k.toLowerCase() === "content-type");
    if (body && !hasContentType) {
      try {
        JSON.parse(body);
        parsedHeaders["Content-Type"] = "application/json";
      } catch (err) {
        // not JSON - leave Content-Type unset, let fetch/the server infer it
      }
    }
    try {
      const res = await fetch(url, {
        method: (method || "POST").toUpperCase(),
        headers: parsedHeaders,
        body: body || undefined,
      });
      ctx.setState("lastUrl", url);
      ctx.setState("lastStatus", res.status);
      ctx.setState("lastCalledAt", Date.now());
      if (!res.ok) {
        ctx.log("call failed:", `HTTP ${res.status}`);
        ctx.emitEvent("callFailed", { url, error: `HTTP ${res.status}` });
        return;
      }
      ctx.emitEvent("callSucceeded", { url, status: res.status });
    } catch (err) {
      ctx.log("call failed:", err.message);
      ctx.emitEvent("callFailed", { url, error: err.message });
    }
  });

  return {
    onConnect() {
      ctx.log("Generic webhook driver ready");
    },
    onDisconnect() {},
  };
}
module.exports = { create };
