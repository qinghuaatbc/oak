"use strict";
// Home Assistant driver over HA's own published WebSocket API
// (developers.home-assistant.io/docs/api/websocket) - not RTI-specific,
// this is HA's real, publicly documented integration surface. Confirmed
// against a real running HA instance before writing this, not guessed:
// connect to ws://host:port/api/websocket, HA sends {"type":
// "auth_required"} first, reply {"type":"auth","access_token":...}, get
// {"type":"auth_ok"} back. Every other request carries an incrementing
// "id" and gets a matching {"id":N,"type":"result",...} response - this
// driver keeps a pending-request map for that, same "request/response
// correlation over one shared socket" pattern Oak's own live-socket.js
// already uses for its browser-facing WS channel.
//
// Two real findings from testing against actual devices (a Lutron Caséta
// dimmer and a hall-closet Insteon-via-HA light) rather than assuming:
// (1) unlike eisy's WS handshake, HA's needs NO special headers/
// subprotocol at all - auth happens entirely via the first message, not
// the HTTP upgrade; (2) the generic cross-domain services
// homeassistant.turn_on/turn_off work correctly on light AND switch AND
// climate entities alike, so this driver's turnOn/turnOff don't need to
// special-case a domain the way eisy's on/off vs climate setpoint
// actions do - one pair of actions genuinely covers every controllable
// domain HA has.

function create(ctx) {
  const useSsl = false; // HA's own connection.fields only offer a plain host/port for now - see manifest.json
  const host = ctx.config.connection.host;
  const port = ctx.config.connection.port || 8123;
  const accessToken = (ctx.config.settings && ctx.config.settings.accessToken) || "";
  const RECONNECT_MS = 5000;

  let ws = null;
  let reconnectHandle = null;
  let stopped = false;
  let nextId = 1;
  const pending = new Map(); // id -> {resolve, reject}
  // Last-seen state per entity - skips redundant setState/emitEvent calls
  // on a duplicate update, same throttle-on-change pattern every other
  // Oak driver in this project already uses.
  let lastState = {};

  function wsRequest(payload) {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== ws.OPEN) return reject(new Error("Not connected"));
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, ...payload }));
    });
  }

  function applyEntityState(entityId, state, attributes) {
    const prevRaw = lastState[entityId];
    const raw = JSON.stringify({ state, brightness: attributes.brightness, current_temperature: attributes.current_temperature, temperature: attributes.temperature });
    if (prevRaw === raw) return;
    lastState[entityId] = raw;

    const domain = entityId.split(".")[0];
    ctx.setState("entity.state", state, entityId);
    if (domain === "light" || domain === "switch") {
      ctx.setState("entity.on", state === "on", entityId);
    }
    if (domain === "light" && attributes.brightness !== undefined) {
      ctx.setState("entity.level", Math.round((attributes.brightness / 255) * 100), entityId);
    }
    if (domain === "climate") {
      if (attributes.current_temperature !== undefined) ctx.setState("climate.currentTemperature", attributes.current_temperature, entityId);
      if (attributes.temperature !== undefined) ctx.setState("climate.targetTemperature", attributes.temperature, entityId);
    }
    ctx.emitEvent("stateChanged", { entityId, state });
  }

  function connect() {
    if (stopped) return;
    const url = `${useSsl ? "wss" : "ws"}://${host}:${port}/api/websocket`;
    ws = new WebSocket(url);

    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (err) {
        return;
      }
      if (msg.type === "auth_required") {
        ws.send(JSON.stringify({ type: "auth", access_token: accessToken }));
        return;
      }
      if (msg.type === "auth_invalid") {
        ctx.log("auth failed:", msg.message);
        return;
      }
      if (msg.type === "auth_ok") {
        ctx.log("authenticated, subscribing to state_changed events");
        wsRequest({ type: "subscribe_events", event_type: "state_changed" }).catch((err) => ctx.log("subscribe failed:", err.message));
        // Baseline read - the subscription only reports CHANGES from here
        // on, so without this every entity would show no state at all
        // until it next changes.
        wsRequest({ type: "get_states" })
          .then((states) => states.forEach((e) => applyEntityState(e.entity_id, e.state, e.attributes || {})))
          .catch((err) => ctx.log("initial get_states failed:", err.message));
        return;
      }
      if (msg.type === "event" && msg.event && msg.event.event_type === "state_changed") {
        const { entity_id, new_state } = msg.event.data;
        if (new_state) applyEntityState(entity_id, new_state.state, new_state.attributes || {});
        return;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.type === "result" && msg.success) resolve(msg.result);
        else reject(new Error((msg.error && msg.error.message) || "request failed"));
      }
    });
    ws.on("close", () => {
      if (stopped) return;
      ctx.log(`disconnected, reconnecting in ${RECONNECT_MS}ms`);
      reconnectHandle = ctx.clock.after(RECONNECT_MS, connect);
    });
    ws.on("error", (err) => ctx.log("connection error:", err.message));
  }

  function callService(domain, service, entityId, serviceData) {
    const payload = { type: "call_service", domain, service };
    if (entityId) payload.target = { entity_id: entityId };
    if (serviceData) payload.service_data = serviceData;
    return wsRequest(payload).catch((err) => ctx.log(`${domain}.${service} failed:`, err.message));
  }

  ctx.onAction("turnOn", ({ entityId }) => callService("homeassistant", "turn_on", entityId));
  ctx.onAction("turnOff", ({ entityId }) => callService("homeassistant", "turn_off", entityId));
  ctx.onAction("setBrightness", ({ entityId, level = 100 }) =>
    callService("light", "turn_on", entityId, { brightness: Math.round((Math.max(0, Math.min(100, level)) / 100) * 255) })
  );
  ctx.onAction("climateSetTemperature", ({ entityId, temperature = 70 }) => callService("climate", "set_temperature", entityId, { temperature }));
  ctx.onAction("callService", ({ domain, service, entityId, serviceData }) => {
    let data;
    if (serviceData) {
      try {
        data = JSON.parse(serviceData);
      } catch (err) {
        ctx.log("callService: serviceData isn't valid JSON:", err.message);
        return;
      }
    }
    return callService(domain, service, entityId, data);
  });
  // Discovers every entity HA currently knows about - reported via a
  // state (JSON array of {address, name}) rather than a return value,
  // since actions are fire-and-forget from the HTTP caller's side (see
  // server.js's action route). Reuses eisy's exact discoverNodes/
  // discovery.nodes convention (see SPEC.md) so the admin UI's "Discover
  // devices" button works here for free - and since HA already reports a
  // real friendly_name for everything (unlike eisy, which has no name of
  // its own for a node), the imported names are HA's own, not a guess.
  ctx.onAction("discoverEntities", async () => {
    try {
      const states = await wsRequest({ type: "get_states" });
      const nodes = states.map((e) => ({ address: e.entity_id, name: (e.attributes && e.attributes.friendly_name) || e.entity_id }));
      ctx.setState("discovery.nodes", JSON.stringify(nodes));
      ctx.emitEvent("nodesDiscovered", { count: nodes.length });
    } catch (err) {
      ctx.log("discovery failed:", err.message);
    }
  });

  return {
    onConnect() {
      ctx.log("Connecting to", `${useSsl ? "wss" : "ws"}://${host}:${port}/api/websocket`);
      connect();
    },
    onDisconnect() {
      stopped = true;
      if (reconnectHandle) reconnectHandle.cancel();
      if (ws) ws.terminate();
    },
  };
}

module.exports = { create };
