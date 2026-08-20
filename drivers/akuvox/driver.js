"use strict";
// Akuvox IP intercom driver over its documented HTTP CGI door-relay
// control API - HIGH confidence, endpoints read directly from Akuvox's
// own official knowledge base (knowledge.akuvox.com/docs/open-door-via-
// http-command and .../trigger-door-actions-via-http-api-e18).
//
// SCOPE: control only, deliberately. Akuvox devices also push call/
// motion/access events via an outbound "Action URL" mechanism (the
// device makes ITS OWN request to a configured third-party URL when
// something happens) rather than exposing a pollable status endpoint -
// architecturally different from every other driver in this project
// (which either poll or open a persistent outbound connection). This
// would require Oak's driver to run its OWN inbound HTTP listener and
// have the installer point the device's Action URL at it. Not
// implemented here: research could not confirm the exact request
// method (GET vs POST) or the complete variable-substitution list from
// Akuvox's own documentation (the two primary PDFs describing it
// wouldn't load), and guessing at that wire format risked silently
// dropping real events rather than a clean, known gap. Door control
// (the part that IS solidly confirmed) is fully implemented below;
// event support is a documented follow-up, not a missing feature that
// was overlooked.
function create(ctx) {
  function apiUrl(action, doorNum) {
    const { username, password } = ctx.config.settings;
    const auth = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password || "")}@` : "";
    return `http://${auth}${ctx.config.connection.host}/fcgi/OpenDoor?action=${action}&DoorNum=${doorNum || 1}`;
  }

  ctx.onAction("openDoor", async ({ doorNum = "1" }) => {
    try {
      const res = await fetch(apiUrl("OpenDoor", doorNum));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      ctx.log(`openDoor failed: ${err.message}`);
    }
  });
  ctx.onAction("closeDoor", async ({ doorNum = "1" }) => {
    try {
      const res = await fetch(apiUrl("CloseDoor", doorNum));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      ctx.log(`closeDoor failed: ${err.message}`);
    }
  });

  return {
    onConnect() {},
    onDisconnect() {},
  };
}

module.exports = { create };
