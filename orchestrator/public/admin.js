import { listInstances, getManifest, getState, getEvents, callAction, listDrivers, addInstance, deleteInstance } from "./api.js";
import { connectLiveSocket } from "./live-socket.js";

const FALLBACK_POLL_MS = 10000; // safety net if the WS connection is down
const REFRESH_DEBOUNCE_MS = 150;
const root = document.getElementById("instances");
let manifests = new Map(); // id -> manifest, fetched once per instance

function fieldInputs(action) {
  return (action.params || [])
    .map(
      (p) =>
        `<input name="${p.key}" type="${p.type === "number" ? "number" : "text"}" placeholder="${p.key}${
          p.default !== undefined ? " = " + p.default : ""
        }" />`
    )
    .join("");
}

function renderInstancePanel(id, manifest, state, events) {
  const stateRows = Object.entries(state)
    .map(([key, value]) => `<tr><td>${key}</td><td>${formatValue(value)}</td></tr>`)
    .join("");

  const actionForms = manifest.actions
    .map(
      (a) => `
      <form data-instance="${id}" data-action="${a.id}">
        <button type="submit">${a.label}</button>
        ${fieldInputs(a)}
      </form>`
    )
    .join("");

  const eventLines = events
    .slice()
    .reverse()
    .map((e) => `<div>${new Date(e.t).toLocaleTimeString()} — ${e.id} ${JSON.stringify(e.params)}</div>`)
    .join("");

  return `
    <section class="panel" data-panel="${id}">
      <h2>${manifest.displayName}
        <button type="button" class="delete-instance" data-instance="${id}" style="float:right">Remove</button>
      </h2>
      <p class="sub">instance "${id}" · driver ${manifest.id}</p>
      <table><thead><tr><th>state</th><th>value</th></tr></thead><tbody>${
        stateRows || `<tr><td colspan="2" class="sub">no state yet</td></tr>`
      }</tbody></table>
      <div class="actions">${actionForms}</div>
      <div class="events">${eventLines || `<div class="sub">no events yet</div>`}</div>
    </section>`;
}

function formatValue(v) {
  if (typeof v === "boolean") return `<span class="pill ${v ? "on" : "off"}">${v ? "on" : "off"}</span>`;
  return String(v);
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
  root.innerHTML = panels.join("") || `<p class="sub">No instances configured.</p>`;
  wireForms();
}

function wireForms() {
  root.querySelectorAll("form[data-instance]").forEach((form) => {
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const instanceId = form.dataset.instance;
      const actionId = form.dataset.action;
      const params = {};
      form.querySelectorAll("input").forEach((input) => {
        if (input.value === "") return;
        params[input.name] = input.type === "number" ? Number(input.value) : input.value;
      });
      try {
        await callAction(instanceId, actionId, params);
      } catch (err) {
        console.error("action failed", err);
      }
      refresh();
    });
  });
  root.querySelectorAll(".delete-instance").forEach((btn) => {
    btn.addEventListener("click", async () => {
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
      <button type="submit">Add</button>`;
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
connectLiveSocket(() => scheduleRefresh());
setInterval(refresh, FALLBACK_POLL_MS);
