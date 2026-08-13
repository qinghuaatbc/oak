import { listInstances, getManifest, getState, getEvents, callAction, listDrivers, addInstance, deleteInstance } from "./api.js";
import { connectLiveSocket } from "./live-socket.js";

const FALLBACK_POLL_MS = 10000; // safety net if the WS connection is down
const REFRESH_DEBOUNCE_MS = 150;
const root = document.getElementById("instances");
const wsPill = document.getElementById("wsPill");
let manifests = new Map(); // id -> manifest, fetched once per instance

// A checkbox-driven switch, same markup shared.js's buildToggleSwitch
// produces in QTI - only rendered when a boolean state has an obviously
// matching on/off action pair to drive it (e.g. relay.on + turnOn/turnOff).
function toggleSwitchHtml(instanceId, onActionId, offActionId, checked) {
  return `<label class="switch" onclick="event.stopPropagation()">
    <input type="checkbox" ${checked ? "checked" : ""} data-instance="${instanceId}" data-on-action="${onActionId}" data-off-action="${offActionId}" />
    <span class="slider-track"></span>
  </label>`;
}

// Only turnOn/turnOff is a real boolean toggle - armStay/disarm LOOKED
// like a pair by action-id matching alone, but DSC's partition.status is a
// string ("armed"/"disarmed"/"alarm"), not boolean, so there's no state to
// drive a switch with. That mismatch produced a real bug: a tile whose
// only actions were folded into a "toggle" that never got a switch (no
// boolean state) AND never got its own submit button (suppressed because
// isToggleAction was true) - armStay became completely unreachable. Fixed
// by only trusting a pair match when a boolean state is actually present
// (see the caller's `useToggle` check) - a false-positive pair now just
// falls through to ordinary per-action tiles instead of going dead.
function findTogglePair(manifest) {
  const ids = new Set(manifest.actions.map((a) => a.id));
  const pairs = [["turnOn", "turnOff"]];
  return pairs.find(([on, off]) => ids.has(on) && ids.has(off));
}

function fieldInputs(action) {
  return (action.params || [])
    .map(
      (p) =>
        `<input name="${p.key}" type="${p.type === "number" ? "number" : "text"}" placeholder="${p.key}${
          p.default !== undefined ? " = " + p.default : ""
        }" onclick="event.stopPropagation()" />`
    )
    .join("");
}

function formatValue(v) {
  if (typeof v === "boolean") return `<span class="status-pill ${v ? "on" : "off"}">${v ? "on" : "off"}</span>`;
  return String(v);
}

function renderInstancePanel(id, manifest, state, events) {
  const togglePair = findTogglePair(manifest);
  const boolStateEntry = Object.entries(state).find(([, v]) => typeof v === "boolean");
  // A matched pair only actually renders as a toggle if there's a real
  // boolean state to show/drive - otherwise every action, pair or not,
  // falls through to a normal tile with its own submit button.
  const useToggle = Boolean(togglePair && boolStateEntry);

  const stateRows = Object.entries(state)
    .map(([key, value]) => `<tr><td>${key}</td><td>${formatValue(value)}</td></tr>`)
    .join("");

  const actionTiles = manifest.actions
    .map((a) => {
      const isToggleAction = useToggle && (a.id === togglePair[0] || a.id === togglePair[1]);
      if (isToggleAction && a.id !== togglePair[0]) return ""; // toggle pair renders as one tile, not two
      const switchHtml = isToggleAction ? toggleSwitchHtml(id, togglePair[0], togglePair[1], boolStateEntry[1]) : "";
      return `
      <form class="tile" data-instance="${id}" data-action="${isToggleAction ? "" : a.id}">
        <div class="row">
          <span class="tname">${isToggleAction ? manifest.displayName : a.label}</span>
          ${switchHtml}
        </div>
        ${isToggleAction ? "" : `<button class="btn small" type="submit">${a.label}</button>`}
        ${fieldInputs(a)}
      </form>`;
    })
    .join("");

  const eventLines = events
    .slice()
    .reverse()
    .map((e) => `<div>${new Date(e.t).toLocaleTimeString()} — ${e.id} ${JSON.stringify(e.params)}</div>`)
    .join("");

  return `
    <section class="card" data-panel="${id}">
      <h2>${manifest.displayName}
        <button type="button" class="btn small danger delete-instance" data-instance="${id}">Remove</button>
      </h2>
      <div class="sub">instance "${id}" · driver ${manifest.id}</div>
      <table><tbody>${stateRows || `<tr><td class="sub">no state yet</td></tr>`}</tbody></table>
      <div class="tile-grid">${actionTiles}</div>
      <div class="events">${eventLines || `<div class="sub">no events yet</div>`}</div>
    </section>`;
}

async function refresh() {
  const list = await listInstances();
  const panels = await Promise.all(
    list.map(async (summary) => {
      if (!manifests.has(summary.id)) manifests.set(summary.id, await getManifest(summary.id));
      const manifest = manifests.get(summary.id);
      const [state, events] = await Promise.all([getState(summary.id), getEvents(summary.id)]);
      return renderInstancePanel(summary.id, manifest, state, events);
    })
  );
  root.innerHTML = panels.join("") || `<p class="empty-hint">No instances configured.</p>`;
  wireForms();
}

function wireForms() {
  root.querySelectorAll("form[data-instance]").forEach((form) => {
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      if (!form.dataset.action) return; // the toggle-pair tile has no submit action of its own
      const params = {};
      form.querySelectorAll("input:not([type=checkbox])").forEach((input) => {
        if (input.value === "") return;
        params[input.name] = input.type === "number" ? Number(input.value) : input.value;
      });
      try {
        await callAction(form.dataset.instance, form.dataset.action, params);
      } catch (err) {
        console.error("action failed", err);
      }
      refresh();
    });
    // The whole tile is clickable (not just its button), matching QTI's
    // light-tile convention - but only for tiles that resolve to exactly
    // one action already (a real submit button), not the multi-field ones.
    if (form.dataset.action && form.querySelectorAll("input:not([type=checkbox])").length === 0) {
      form.addEventListener("click", () => form.requestSubmit());
    }
  });
  root.querySelectorAll('input[type=checkbox][data-on-action]').forEach((input) => {
    input.addEventListener("change", async () => {
      const action = input.checked ? input.dataset.onAction : input.dataset.offAction;
      try {
        await callAction(input.dataset.instance, action, {});
      } catch (err) {
        console.error("action failed", err);
      }
      refresh();
    });
  });
  root.querySelectorAll(".delete-instance").forEach((btn) => {
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (!confirm(`Remove instance "${btn.dataset.instance}"?`)) return;
      await deleteInstance(btn.dataset.instance);
      manifests.delete(btn.dataset.instance);
      refresh();
    });
  });
}

// --- Add-instance form: rendered once at startup (not on every poll/WS
// refresh, so in-progress typing in the id/connection fields never gets
// wiped out from under the user) ---
async function setupAddInstanceForm() {
  const drivers = await listDrivers();
  const fieldsRoot = document.getElementById("add-instance-fields");

  function configFieldInput(prefix, f) {
    return `<input name="${prefix}.${f.key}" type="${f.type === "number" ? "number" : "text"}" placeholder="${f.label}${
      f.default !== undefined ? " (" + f.default + ")" : ""
    }" />`;
  }

  function renderFieldsFor(driverId) {
    const manifest = drivers.find((d) => d.id === driverId);
    if (!manifest) {
      fieldsRoot.innerHTML = "";
      return;
    }
    const connFields = (manifest.connection.options[0].fields || []).map((f) => configFieldInput("connection", f)).join("");
    const settingFields = (manifest.settings || []).map((f) => configFieldInput("settings", f)).join("");
    fieldsRoot.innerHTML = `
      <input name="id" placeholder="instance id (e.g. relay2)" required />
      ${connFields}
      ${settingFields}
      <button class="btn small primary" type="submit">Add</button>`;
  }

  const driverPicker = document.createElement("select");
  driverPicker.name = "driver";
  driverPicker.innerHTML = drivers.map((d) => `<option value="${d.id}">${d.displayName}</option>`).join("");
  fieldsRoot.before(driverPicker);
  driverPicker.addEventListener("change", () => renderFieldsFor(driverPicker.value));
  renderFieldsFor(driverPicker.value);

  document.getElementById("add-instance-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const form = ev.target;
    const id = form.querySelector('[name="id"]').value.trim();
    const connection = { transport: drivers.find((d) => d.id === driverPicker.value).connection.options[0].transport };
    const settings = {};
    form.querySelectorAll("input").forEach((input) => {
      if (input.name === "id" || input.value === "") return;
      const [group, key] = input.name.split(".");
      const value = input.type === "number" ? Number(input.value) : input.value;
      if (group === "connection") connection[key] = value;
      else if (group === "settings") settings[key] = value;
    });
    if (!id) return;
    const result = await addInstance(id, driverPicker.value, connection, settings);
    if (result.error) {
      alert(result.error);
      return;
    }
    form.querySelectorAll("input").forEach((input) => (input.value = ""));
    refresh();
  });
}

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, REFRESH_DEBOUNCE_MS);
}

refresh();
setupAddInstanceForm();
connectLiveSocket(
  () => scheduleRefresh(),
  (connected) => {
    wsPill.textContent = connected ? "connected" : "disconnected";
    wsPill.className = "status-pill " + (connected ? "on" : "off");
  }
);
setInterval(refresh, FALLBACK_POLL_MS);
