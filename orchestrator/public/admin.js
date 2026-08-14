import {
  listInstances, getManifest, getState, callAction, listDrivers, addInstance, deleteInstance,
  getConfig, editInstance, stopInstance, startInstance,
  getHealth, listMacros, saveMacro, deleteMacro, runMacro,
  listCameras, addCamera, deleteCamera, listGlbModels, uploadGlb,
  uploadDriver, deleteDriverPackage,
  getBindings, saveBindings, autoGenerateBindings,
} from "./api.js";
import { connectLiveSocket } from "./live-socket.js";
import { attachCameraPlayer } from "./camera-player.js";
import { create3DViewer } from "./viewer3d.js";
import { CATEGORY_ICON, CATEGORY_LABEL, CATEGORY_ORDER, effectiveCategories, getOnOffPair } from "./roles.js";

const FALLBACK_POLL_MS = 10000;
const REFRESH_DEBOUNCE_MS = 150;
const MAX_LOG_LINES = 1000;

let manifests = new Map(); // id -> manifest
let instanceIds = [];
let runningByInstance = new Map(); // id -> boolean
let statesByInstance = new Map(); // id -> {key: value}
let labelByInstance = new Map(); // id -> string|undefined - QTI's own generic "Label (optional, to tell instances apart)" field, e.g. telling two eisy instances apart
let bindingsCache = null; // {light:[], switch:[], ...} - loaded when the Dashboard tab is opened
let macrosCache = []; // loaded alongside bindingsCache - macros are a valid On/Off function target
let configByInstance = new Map(); // instanceId -> getConfig() result, loaded alongside bindingsCache - source of a slot's fixed-argument dropdown (see deviceNameOptionsForSlot)

// Everywhere the UI shows "which instance is this", show the admin's own
// label if they set one, falling back to the driver's generic
// displayName - matters once there's more than one instance of the same
// driver (two eisy boxes, two relays, ...) where the driver name alone
// can't tell them apart.
function instanceLabel(id) {
  return labelByInstance.get(id) || (manifests.get(id) || {}).displayName || id;
}
const logBuffer = []; // {instanceId, label, text} - fed live by WS "event" messages

const countPill = document.getElementById("countPill");
const instancesListEl = document.getElementById("instancesList");
const instanceFilter = document.getElementById("instanceFilter");
const stateBody = document.getElementById("stateBody");
const actionsGrid = document.getElementById("actionsGrid");
const eventsLog = document.getElementById("eventsLog");

// --- Collapsible cards, ported from QTI's own app.js makeCardsCollapsible()
// (same localStorage-keyed-by-title persistence, same data-default-collapsed
// opt-in) - reused as-is since it's this project's own generic mechanism,
// not QTI-specific. ---
function makeCardsCollapsible() {
  document.querySelectorAll(".card").forEach((card) => {
    if (card.__setCollapsed) return; // already wired - avoid duplicate chevrons/listeners on re-render
    const header = card.firstElementChild;
    if (!header) return;
    const h2 = header.tagName === "H2" ? header : header.querySelector("h2");
    if (!h2) return;
    const key = "oak_card_collapsed_" + h2.textContent.trim().toLowerCase().replace(/\s+/g, "_");
    const chev = document.createElement("span");
    chev.className = "card-chev";
    h2.insertBefore(chev, h2.firstChild);
    header.style.cursor = "pointer";
    function applyState(collapsed) {
      Array.from(card.children).forEach((child) => {
        if (child === header) return;
        child.style.display = collapsed ? "none" : "";
      });
      chev.textContent = collapsed ? "▸" : "▾";
    }
    const saved = localStorage.getItem(key);
    let collapsed = saved !== null ? saved === "1" : card.dataset.defaultCollapsed === "true";
    applyState(collapsed);
    card.__setCollapsed = (c) => {
      collapsed = c;
      applyState(collapsed);
      localStorage.setItem(key, collapsed ? "1" : "0");
    };
    header.addEventListener("click", (ev) => {
      if (["BUTTON", "INPUT", "SELECT"].includes(ev.target.tagName)) return;
      card.__setCollapsed(!collapsed);
    });
  });
}

function updateCountPill() {
  const n = [...runningByInstance.values()].filter(Boolean).length;
  countPill.textContent = n === 0 ? "no instances running" : n + " instance" + (n === 1 ? "" : "s") + " running";
  countPill.className = "status-pill " + (n === 0 ? "off" : "on");
}

function renderInstancesList() {
  instancesListEl.innerHTML = "";
  if (!instanceIds.length) {
    instancesListEl.innerHTML = `<p class="empty-hint">No driver instances yet.</p>`;
    return;
  }
  instanceIds.forEach((id) => {
    const manifest = manifests.get(id);
    const running = runningByInstance.get(id);
    const row = document.createElement("div");
    row.className = "instance-row" + (running ? "" : " stopped");
    row.title = "Click to view/edit this instance in State/Actions/Events/Config";
    row.innerHTML = `<div><div class="iname">${instanceLabel(id)}${
      running ? "" : ' <span class="istatus">stopped</span>'
    }</div><div class="ikey">${manifest.id} · ${id}</div></div>`;
    row.addEventListener("click", () => {
      instanceFilter.value = id;
      renderActivePanel({ allowConfigRerender: true });
    });
    const btnRow = document.createElement("div");
    btnRow.className = "row";

    const toggleRunBtn = document.createElement("button");
    toggleRunBtn.className = "btn small" + (running ? " danger" : "");
    toggleRunBtn.textContent = running ? "Stop" : "Start";
    toggleRunBtn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const result = running ? await stopInstance(id) : await startInstance(id);
      if (result.error) alert(result.error);
      fullRefresh();
    });
    btnRow.appendChild(toggleRunBtn);

    const delBtn = document.createElement("button");
    delBtn.className = "btn small danger";
    delBtn.textContent = "Remove";
    delBtn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (!confirm(`Remove instance "${id}"?`)) return;
      await deleteInstance(id);
      manifests.delete(id);
      statesByInstance.delete(id);
      runningByInstance.delete(id);
      fullRefresh();
    });
    btnRow.appendChild(delBtn);

    row.appendChild(btnRow);
    instancesListEl.appendChild(row);
  });
}

function renderInstanceFilter() {
  const prev = instanceFilter.value;
  instanceFilter.innerHTML = "";
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "All instances";
  instanceFilter.appendChild(all);
  instanceIds.forEach((id) => {
    const o = document.createElement("option");
    o.value = id;
    o.textContent = instanceLabel(id) + " (" + id + ")";
    instanceFilter.appendChild(o);
  });
  instanceFilter.value = [...instanceFilter.options].some((o) => o.value === prev) ? prev : "";
}

function renderStatePanel() {
  const filter = instanceFilter.value;
  stateBody.innerHTML = "";
  const rows = [];
  instanceIds.forEach((id) => {
    if (filter && id !== filter) return;
    const state = statesByInstance.get(id) || {};
    Object.entries(state).forEach(([key, value]) => rows.push({ id, key, value }));
  });
  if (!rows.length) {
    stateBody.innerHTML = `<tr><td colspan="3" class="empty-hint">no state yet</td></tr>`;
    return;
  }
  rows.forEach(({ id, key, value }) => {
    const tr = document.createElement("tr");
    const valueHtml = typeof value === "boolean" ? `<span class="status-pill ${value ? "on" : "off"}">${value ? "on" : "off"}</span>` : String(value);
    tr.innerHTML = `<td>${instanceLabel(id)}</td><td>${key}</td><td>${valueHtml}</td>`;
    stateBody.appendChild(tr);
  });
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

// A "keyvalue" settings field (e.g. eisy's per-node address->name map,
// matching QTI's own per-device Name fields in ConfigSettings.xml, just
// as a proper dynamic list instead of QTI's fixed Name0..Name127 slots -
// Oak's settings schema has no fixed-count constraint to work around, so
// there's no reason to cap it at some arbitrary number). Stored as a
// plain {key: value} object under settings.<key>. Not expressible as a
// single <input>, so it's handled in two steps: a placeholder div is
// emitted alongside the other string-templated fields, then
// wireKeyValueField() turns it into an interactive add/remove row list
// once the placeholder is actually in the DOM.
function keyValueFieldPlaceholder(prefix, f) {
  return `<div class="lbl">${f.label}</div><div class="keyvalue-rows" data-keyvalue-field="${prefix}.${f.key}"></div><button type="button" class="btn small" data-keyvalue-add="${prefix}.${f.key}">+ Add</button>`;
}
function wireKeyValueField(form, prefix, f, currentValue) {
  const rowsEl = form.querySelector(`[data-keyvalue-field="${prefix}.${f.key}"]`);
  const addBtn = form.querySelector(`[data-keyvalue-add="${prefix}.${f.key}"]`);
  if (!rowsEl || !addBtn) return;
  function addRow(k, v) {
    const row = document.createElement("div");
    row.className = "row";
    row.style.marginBottom = "6px";
    const keyInput = document.createElement("input");
    keyInput.className = "kv-key";
    keyInput.placeholder = f.keyLabel || "key";
    keyInput.value = k || "";
    const valInput = document.createElement("input");
    valInput.className = "kv-val";
    valInput.placeholder = f.valueLabel || "value";
    valInput.value = v || "";
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "btn small danger";
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", () => row.remove());
    row.append(keyInput, valInput, removeBtn);
    rowsEl.appendChild(row);
  }
  Object.entries(currentValue || {}).forEach(([k, v]) => addRow(k, v));
  addBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    addRow("", "");
  });
}
// Collects every keyvalue field in `form` into {settings.<key>: {...}} /
// {connection.<key>: {...}} shaped output, merged into the caller's
// connection/settings objects - called instead of, not in addition to,
// treating .kv-key/.kv-val as plain named inputs (they deliberately have
// no name attribute, so the generic input-collection loop must skip them).
function collectKeyValueFields(form, connection, settings) {
  form.querySelectorAll("[data-keyvalue-field]").forEach((rowsEl) => {
    const [group, key] = rowsEl.dataset.keyvalueField.split(".");
    const obj = {};
    rowsEl.querySelectorAll(".row").forEach((row) => {
      const k = row.querySelector(".kv-key").value.trim();
      const v = row.querySelector(".kv-val").value.trim();
      if (k) obj[k] = v;
    });
    (group === "connection" ? connection : settings)[key] = obj;
  });
}

function renderActionsPanel() {
  const filter = instanceFilter.value;
  actionsGrid.innerHTML = "";
  const visible = filter ? [filter] : instanceIds;
  if (!visible.length) {
    actionsGrid.innerHTML = `<p class="empty-hint">No instances to show.</p>`;
    return;
  }
  visible.forEach((id) => {
    if (!runningByInstance.get(id)) {
      const notice = document.createElement("p");
      notice.className = "empty-hint";
      notice.textContent = `${instanceLabel(id)} is stopped - start it (Running instances, or the Config tab) to use its actions.`;
      actionsGrid.appendChild(notice);
      return;
    }
    const manifest = manifests.get(id);
    const state = statesByInstance.get(id) || {};
    const togglePair = getOnOffPair(manifest);
    const boolEntry = Object.entries(state).find(([, v]) => typeof v === "boolean");
    const useToggle = Boolean(togglePair && boolEntry);

    manifest.actions.forEach((a) => {
      const isToggleAction = useToggle && (a.id === togglePair[0] || a.id === togglePair[1]);
      if (isToggleAction && a.id !== togglePair[0]) return;
      const form = document.createElement("form");
      form.className = "tile";
      form.dataset.instance = id;
      if (!isToggleAction) form.dataset.action = a.id;
      const switchHtml = isToggleAction
        ? `<label class="switch" onclick="event.stopPropagation()"><input type="checkbox" ${
            boolEntry[1] ? "checked" : ""
          } data-instance="${id}" data-on-action="${togglePair[0]}" data-off-action="${togglePair[1]}" /><span class="slider-track"></span></label>`
        : "";
      form.innerHTML = `
        <div class="row">
          <span class="tname">${isToggleAction ? instanceLabel(id) : a.label}</span>
          ${switchHtml}
        </div>
        ${isToggleAction ? "" : `<button class="btn small" type="submit">${a.label}</button>`}
        ${fieldInputs(a)}
        <div class="tstate">${instanceLabel(id)} · ${id}</div>`;
      actionsGrid.appendChild(form);
    });
  });
  wireActionForms();
}

function wireActionForms() {
  actionsGrid.querySelectorAll("form[data-action]").forEach((form) => {
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
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
    });
    if (form.querySelectorAll("input:not([type=checkbox])").length === 0) {
      form.addEventListener("click", () => form.requestSubmit());
    }
  });
  actionsGrid.querySelectorAll("input[type=checkbox][data-on-action]").forEach((input) => {
    input.addEventListener("change", async () => {
      const action = input.checked ? input.dataset.onAction : input.dataset.offAction;
      try {
        await callAction(input.dataset.instance, action, {});
      } catch (err) {
        console.error("action failed", err);
      }
    });
  });
}

// Ported from QTI's app.js logPanel/logLine/renderLogPanel: keep every
// line in a buffer (not just appended straight to the DOM) so the instance
// filter can re-slice without losing history from instances not currently
// selected, and only auto-scroll to a new line if the user was already
// near the bottom - otherwise a chatty driver yanks the view back down
// mid-read.
function logLine(instanceId, text) {
  const label = manifests.has(instanceId) ? instanceLabel(instanceId) : instanceId;
  logBuffer.push({ instanceId, label, text });
  if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift();
  if (document.getElementById("eventsSubPanel").classList.contains("active")) renderEventsPanel();
}

function renderEventsPanel() {
  const wasNearBottom = eventsLog.scrollHeight - eventsLog.scrollTop - eventsLog.clientHeight < 40;
  const filter = instanceFilter.value;
  eventsLog.innerHTML = "";
  logBuffer
    .filter((e) => !filter || e.instanceId === filter)
    .forEach((e) => {
      const div = document.createElement("div");
      div.className = "line";
      div.textContent = `[${e.label}] ${e.text}`;
      eventsLog.appendChild(div);
    });
  if (wasNearBottom) eventsLog.scrollTop = eventsLog.scrollHeight;
  if (!logBuffer.length) eventsLog.innerHTML = `<p class="empty-hint">no events yet</p>`;
}

// Config only makes sense for exactly one instance at a time - editing
// several instances' connection/settings at once through one form isn't a
// coherent operation the way "show all their states in one table" is.
async function renderConfigPanel() {
  const configPanel = document.getElementById("configPanel");
  const id = instanceFilter.value;
  if (!id) {
    configPanel.innerHTML = `<p class="empty-hint">Pick a specific instance above to view or edit its config.</p>`;
    return;
  }
  const manifest = manifests.get(id);
  const running = runningByInstance.get(id);
  const cfg = await getConfig(id);
  const driverManifests = await listDrivers();
  const driverManifest = driverManifests.find((d) => d.id === manifest.id);

  // keyvalue fields (deviceNames, zoneNames, ...) live in their own,
  // always-enabled form - the driver never reads them itself (pure
  // display metadata), so server.js's editInstance already allows saving
  // them regardless of running state. Splitting them out of
  // editInstanceForm (which stays gated on !running, since THAT one can
  // touch a real connection/setting) is what makes that possible - a
  // single form can't be "half disabled" cleanly.
  function fieldInput(prefix, f, currentValue) {
    const value = currentValue !== undefined ? currentValue : f.default;
    return `<label><span class="lbl">${f.label}</span><input name="${prefix}.${f.key}" type="${
      f.type === "number" ? "number" : "text"
    }" value="${value !== undefined ? value : ""}" ${running ? "disabled" : ""} /></label>`;
  }
  const connFieldDefs = driverManifest.connection.options[0].fields || [];
  const settingFieldDefs = driverManifest.settings || [];
  const connFields = connFieldDefs
    .filter((f) => f.type !== "keyvalue")
    .map((f) => fieldInput("connection", f, cfg.connection[f.key]))
    .join("");
  const settingFields = settingFieldDefs
    .filter((f) => f.type !== "keyvalue")
    .map((f) => fieldInput("settings", f, cfg.settings[f.key]))
    .join("");
  const kvFieldDefs = [
    ...connFieldDefs.filter((f) => f.type === "keyvalue").map((f) => ({ prefix: "connection", f })),
    ...settingFieldDefs.filter((f) => f.type === "keyvalue").map((f) => ({ prefix: "settings", f })),
  ];
  const kvFields = kvFieldDefs.map(({ prefix, f }) => keyValueFieldPlaceholder(prefix, f)).join("");

  // A driver that declares BOTH a "discoverNodes" action and a
  // "discovery.nodes" state gets a "Discover devices" button for free -
  // a naming convention (documented in SPEC.md), not something special-
  // cased to eisy specifically, so any future driver author can opt in
  // the same way.
  const hasDiscovery = driverManifest.actions.some((a) => a.id === "discoverNodes") && driverManifest.states.some((s) => s.id === "discovery.nodes");

  configPanel.innerHTML = `
    <p class="sub">instance "${id}" · driver ${manifest.id} · ${running ? "running" : "stopped"}</p>
    <p class="sub">Dashboard presentation (name, category, which function is On/Off/Level) is configured on the <a href="#dashboard" onclick="location.hash='dashboard'">Dashboard</a> tab, not here - it's a binding, not part of this instance's connection.</p>
    <form id="editLabelForm" class="config-form">
      <label><span class="lbl">Label (optional, to tell instances apart, e.g. Kitchen Eisy)</span>
        <input name="label" type="text" value="${cfg.label || ""}" /></label>
      <button class="btn small primary" type="submit">Save label</button>
    </form>
    ${
      hasDiscovery
        ? `<div class="config-form">
             <button class="btn small" type="button" id="discoverBtn" ${running ? "" : "disabled"}>${running ? "🔍 Discover devices" : "🔍 Discover devices (start the instance first)"}</button>
             <div id="discoverResults"></div>
           </div>`
        : ""
    }
    ${
      kvFieldDefs.length
        ? `<form id="editKeyValueForm" class="config-form">${kvFields}<button class="btn small primary" type="submit">Save names</button></form>`
        : ""
    }
    ${
      running
        ? `<p class="empty-hint">Stop this instance before editing its connection/settings - editing a live connection out from under it isn't safe.</p>`
        : ""
    }
    <form id="editInstanceForm" class="config-form">
      ${connFields}
      ${settingFields}
      <button class="btn small primary" type="submit" ${running ? "disabled" : ""}>Save</button>
    </form>
    <div class="row" style="margin-top:12px;">
      <button class="btn small${running ? " danger" : ""}" id="configToggleRunBtn">${running ? "Stop" : "Start"}</button>
    </div>`;

  if (kvFieldDefs.length) {
    const kvFormEl = document.getElementById("editKeyValueForm");
    kvFieldDefs.forEach(({ prefix, f }) => wireKeyValueField(kvFormEl, prefix, f, cfg[prefix][f.key]));
    kvFormEl.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const connection = {};
      const settings = {};
      collectKeyValueFields(ev.target, connection, settings);
      const result = await editInstance(id, { connection, settings });
      if (result.error) {
        alert(result.error);
        return;
      }
      fullRefresh();
    });
  }

  if (hasDiscovery) {
    document.getElementById("discoverBtn").addEventListener("click", async () => {
      const btn = document.getElementById("discoverBtn");
      btn.disabled = true;
      btn.textContent = "Discovering…";
      try {
        await callAction(id, "discoverNodes", {});
        await new Promise((r) => setTimeout(r, 1200)); // action is fire-and-forget; give it a moment to finish and setState
        const state = await getState(id);
        const nodes = JSON.parse(state["discovery.nodes"] || "[]");
        const resultsEl = document.getElementById("discoverResults");
        if (!nodes.length) {
          resultsEl.innerHTML = `<p class="empty-hint">No devices found.</p>`;
        } else {
          resultsEl.innerHTML =
            nodes
              .map(
                (n, i) =>
                  `<label style="display:flex; align-items:center; gap:6px; margin:4px 0;"><input type="checkbox" checked data-discover-idx="${i}" /> <span class="ikey">${n.address}</span> → ${n.name}</label>`
              )
              .join("") + `<button class="btn small primary" type="button" id="importDiscoveredBtn" style="margin-top:8px;">Import checked into Device Names</button>`;
          document.getElementById("importDiscoveredBtn").addEventListener("click", async () => {
            if (!kvFieldDefs.length) {
              alert("This driver has no Device Names field to import into.");
              return;
            }
            const checked = [...resultsEl.querySelectorAll("input[type=checkbox]:checked")].map((c) => nodes[Number(c.dataset.discoverIdx)]);
            const { prefix, f } = kvFieldDefs[0];
            const merged = { ...cfg[prefix][f.key] };
            checked.forEach((n) => (merged[n.address] = n.name));
            const update = prefix === "connection" ? { connection: { [f.key]: merged } } : { settings: { [f.key]: merged } };
            const result = await editInstance(id, update);
            if (result.error) {
              alert(result.error);
              return;
            }
            renderConfigPanel();
          });
        }
      } catch (err) {
        document.getElementById("discoverResults").innerHTML = `<p class="empty-hint">Discovery failed: ${err.message}</p>`;
      } finally {
        btn.disabled = false;
        btn.textContent = "🔍 Discover devices";
      }
    });
  }

  document.getElementById("configToggleRunBtn").addEventListener("click", async () => {
    const result = running ? await stopInstance(id) : await startInstance(id);
    if (result.error) alert(result.error);
    fullRefresh();
  });

  document.getElementById("editLabelForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const label = ev.target.querySelector('[name="label"]').value.trim();
    const result = await editInstance(id, { label });
    if (result.error) {
      alert(result.error);
      return;
    }
    fullRefresh();
  });

  if (!running) {
    document.getElementById("editInstanceForm").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const connection = {};
      const settings = {};
      ev.target.querySelectorAll("input").forEach((input) => {
        const [group, key] = input.name.split(".");
        const value = input.type === "number" ? Number(input.value) : input.value;
        if (group === "connection") connection[key] = value;
        else settings[key] = value;
      });
      const result = await editInstance(id, { connection, settings });
      if (result.error) {
        alert(result.error);
        return;
      }
      fullRefresh();
    });
  }
}

// configSubPanel is deliberately excluded from the live/poll refresh path
// below - it's an editor, not a live-state view, same reasoning as the
// Dashboard tab (see fullRefresh()'s comment). A driver streaming frequent
// state events (e.g. Home Assistant's state_changed subscription) fires
// scheduleRefresh() -> fullRefresh() -> renderActivePanel() many times a
// minute; if that rebuilt the config panel's innerHTML each time, it would
// wipe out an in-progress "+ Add" keyvalue row (or any typed-but-unsaved
// text in it) before the admin could ever finish it - confirmed as a real,
// hit-in-practice bug, not hypothetical. It's (re)rendered explicitly
// instead: once when the tab/instance is opened, and after actions that
// are known to change what it should show (save, discover-import,
// start/stop already call fullRefresh() themselves post-action).
function renderActivePanel({ allowConfigRerender = false } = {}) {
  renderInstanceFilter();
  const activePanel = document.querySelector(".subtabs .st.active").dataset.panel;
  if (activePanel === "stateSubPanel") renderStatePanel();
  else if (activePanel === "actionsSubPanel") renderActionsPanel();
  else if (activePanel === "configSubPanel") {
    if (allowConfigRerender) renderConfigPanel();
  } else renderEventsPanel();
}

document.querySelectorAll(".subtabs .st").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".subtabs .st").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".subpanel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(tab.dataset.panel).classList.add("active");
    renderActivePanel({ allowConfigRerender: true });
  });
});
instanceFilter.addEventListener("change", () => renderActivePanel({ allowConfigRerender: true }));

// --- Main tabs (Driver/Dashboard/Camera/Automation/Macro/Scenes/Trends/3D/
// Layout/Templates/Health/Customers), same lazy-render-on-click pattern as
// the Driver tab's own State/Actions/Events/Config subtabs. Only Dashboard/
// Camera/Macro/Health have real content behind them right now - the rest
// are visible-but-inert placeholder pages, not fake functionality.
// Deep-linkable via #page - also just a plain useful feature (bookmark/
// share a direct link to the Health tab), not only a testing convenience. ---
function activateMainTab(page) {
  const tab = document.querySelector(`nav.maintabs .mt[data-page="${page}"]`);
  if (!tab) return;
  document.querySelectorAll("nav.maintabs .mt").forEach((t) => t.classList.remove("active"));
  document.querySelectorAll("main .page").forEach((p) => p.classList.remove("active"));
  tab.classList.add("active");
  document.getElementById(`page-${page}`).classList.add("active");
  if (page === "dashboard") renderDashboardTab();
  else if (page === "macro") renderMacrosTab();
  else if (page === "health") renderHealthTab();
  else if (page === "camera") renderCameraTab();
  else if (page === "3d" && !viewer3dInited) initViewer3DWithRetry();
}
document.querySelectorAll("nav.maintabs .mt").forEach((tab) => {
  tab.addEventListener("click", () => {
    location.hash = tab.dataset.page;
  });
});
window.addEventListener("hashchange", () => activateMainTab(location.hash.slice(1)));

function activeMainTab() {
  return document.querySelector("nav.maintabs .mt.active").dataset.page;
}

// --- Dashboard: QTI's own binding-editor model, ported directly rather
// than Oak's earlier (now removed) 1-tile-per-instance approach. A
// "slot" names a device (e.g. "kitchen light") - see roles.js's header
// comment for the full shape. On/Off/Level EACH independently pick their
// own instance+action (not one shared instance for the whole slot, the
// way an earlier version of this simplified it) - this is what lets a
// real QTI-style binding express "On also runs a macro" or "On calls hub
// A but Off calls hub B", matching QTI's actual screenshot (On function
// and Off function each have their own "Function -> instance -> action"
// picker). On/Off additionally choose "Call a function" vs "Run a macro"
// (Level stays action-only - a macro has no way to carry a live drag
// value). This tab is purely an editor - live state/toggling happens on
// live.html, same split QTI itself has between its admin bindings editor
// and its live pages.
//
// Convention: a param literally named "level" on an action is the LIVE
// value (set by a drag/slider), never a fixed argument - every other
// param across the slot's chosen action-kind functions (e.g. "zone") is
// editable as a fixed argument in the "Fixed arguments" box, shared
// across On/Off/Level since Oak's own driver convention already
// standardizes on one param name ("zone") for this rather than QTI's
// pattern of re-entering the same value independently per function.
function actionParams(manifest, actionId) {
  const action = manifest && manifest.actions.find((a) => a.id === actionId);
  return action ? action.params || [] : [];
}
function fixedParamKeysForSlot(slot) {
  const keys = new Set();
  [slot.onFn, slot.offFn, slot.levelFn].forEach((f) => {
    if (!f || f.kind === "macro") return;
    actionParams(manifests.get(f.instanceId), f.actionId).forEach((p) => {
      if (p.key !== "level") keys.add(p.key);
    });
  });
  return [...keys];
}

// Matches QTI's own real behavior (its "Name" field for a function like
// eisy's Light On is a dropdown, not free text, sourced from the
// driver's own configured device list) - if the slot's instance has
// exactly one non-empty `type: "keyvalue"` setting (deviceNames,
// zoneNames, ...), that's an unambiguous source of "raw id -> friendly
// name" pairs to offer as a dropdown instead of asking the admin to
// type/copy a cryptic raw address by hand. Returns null (fall back to a
// plain text input) when there's no such setting, or when there's more
// than one and no way to tell which one this fixed argument means (e.g.
// dsc-powerseries has both zoneNames and partitionNames).
function deviceNameOptionsForSlot(slot) {
  const instanceIds = [slot.onFn, slot.offFn, slot.levelFn]
    .filter((f) => f && f.kind !== "macro")
    .map((f) => f.instanceId);
  for (const id of new Set(instanceIds)) {
    const manifest = manifests.get(id);
    const cfg = configByInstance.get(id);
    if (!manifest || !cfg || !cfg.settings) continue;
    const kvKeys = (manifest.settings || []).filter((s) => s.type === "keyvalue").map((s) => s.key);
    const nonEmpty = kvKeys.filter((key) => cfg.settings[key] && Object.keys(cfg.settings[key]).length);
    if (nonEmpty.length === 1) return Object.entries(cfg.settings[nonEmpty[0]]);
  }
  return null;
}

// Builds one On/Off/Level function editor: a "Call a function" vs "Run a
// macro" choice (allowMacro only), an Instance+Action pair for action
// mode, or a Macro picker for macro mode - both sub-blocks stay in the
// DOM and just toggle visibility rather than being destroyed/rebuilt on
// every kind switch, so listeners only get wired once.
// Renders the currently-selected action's own fixed params (e.g. a hub's
// "address"/"zone" param, excluding the live "level" value) INSIDE this
// function's own box - matching QTI's actual layout (its "Name" field for
// a function like eisy's Light On sits inside that function's own
// "Function" box, not in a separate shared section). The underlying value
// is still ONE shared slot.fixedArgs object, not a per-function copy - so
// filling in "kitchen" for On also fills it in for Off/Level's own boxes
// once onChanged() (passed in by buildSlotRow) refreshes every function
// editor. A dropdown of friendly names replaces free text whenever the
// instance has a usable device-names setting (see
// deviceNameOptionsForSlot) - matching QTI's own real behavior, where
// "Name" is a dropdown sourced from the driver's configured device list,
// not something you type/copy a raw address into by hand.
function renderFnParams(paramsBox, slot, instanceId, actionId) {
  paramsBox.innerHTML = "";
  const manifest = manifests.get(instanceId);
  const action = manifest && manifest.actions.find((a) => a.id === actionId);
  const params = action ? (action.params || []).filter((p) => p.key !== "level") : [];
  if (!params.length) return;
  const nameOptions = deviceNameOptionsForSlot(slot);
  params.forEach((p) => {
    const wrap = document.createElement("label");
    const labelEl = document.createElement("span");
    labelEl.className = "lbl";
    labelEl.textContent = p.label || p.key;
    wrap.appendChild(labelEl);
    const currentValue = (slot.fixedArgs && slot.fixedArgs[p.key]) || "";
    let input;
    if (nameOptions && nameOptions.length) {
      input = document.createElement("select");
      input.innerHTML =
        `<option value="">— ${p.label || p.key} —</option>` + nameOptions.map(([raw, name]) => `<option value="${raw}">${name} (${raw})</option>`).join("");
      input.value = currentValue;
    } else {
      input = document.createElement("input");
      input.placeholder = p.label || p.key;
      input.value = currentValue;
    }
    input.dataset.fixedArgKey = p.key;
    wrap.appendChild(input);
    paramsBox.appendChild(wrap);
  });
}

function buildFnEditor(container, label, slot, fnKey, allowMacro, onChanged) {
  const wrap = document.createElement("div");
  wrap.className = "slot-fn-group";
  const labelEl = document.createElement("div");
  labelEl.className = "lbl";
  labelEl.textContent = label;
  wrap.appendChild(labelEl);

  let kindSel = null;
  if (allowMacro) {
    kindSel = document.createElement("select");
    kindSel.innerHTML = `<option value="action">Call a function</option><option value="macro">Run a macro</option>`;
    wrap.appendChild(kindSel);
  }

  const actionBox = document.createElement("div");
  const instSel = document.createElement("select");
  const actSel = document.createElement("select");
  const paramsBox = document.createElement("div");
  actionBox.append(instSel, actSel, paramsBox);

  const macroBox = document.createElement("div");
  const macroSel = document.createElement("select");
  macroBox.append(macroSel);

  wrap.append(actionBox, macroBox);
  container.appendChild(wrap);

  function currentValue() {
    const kind = kindSel ? kindSel.value : "action";
    if (kind === "macro") return macroSel.value ? { kind: "macro", macroId: macroSel.value } : undefined;
    return instSel.value && actSel.value ? { kind: "action", instanceId: instSel.value, actionId: actSel.value } : undefined;
  }
  function populateInstances() {
    const f = slot[fnKey];
    instSel.innerHTML =
      `<option value="">— instance —</option>` +
      instanceIds.map((id) => `<option value="${id}">${instanceLabel(id)} (${id})</option>`).join("");
    instSel.value = (f && f.kind !== "macro" && f.instanceId) || "";
  }
  function populateActions() {
    const manifest = manifests.get(instSel.value);
    const f = slot[fnKey];
    actSel.innerHTML =
      `<option value="">— function —</option>` + (manifest ? manifest.actions.map((a) => `<option value="${a.id}">${a.label} (${a.id})</option>`).join("") : "");
    actSel.value = (f && f.kind !== "macro" && f.actionId) || "";
    renderFnParams(paramsBox, slot, instSel.value, actSel.value);
  }
  function populateMacros() {
    const f = slot[fnKey];
    macroSel.innerHTML = `<option value="">— macro —</option>` + macrosCache.map((m) => `<option value="${m.id}">${m.name}</option>`).join("");
    macroSel.value = (f && f.kind === "macro" && f.macroId) || "";
  }
  function updateVisibility() {
    const kind = kindSel ? kindSel.value : "action";
    actionBox.style.display = kind === "macro" ? "none" : "";
    macroBox.style.display = kind === "macro" ? "" : "none";
  }

  if (kindSel) {
    kindSel.value = slot[fnKey] && slot[fnKey].kind === "macro" ? "macro" : "action";
    kindSel.addEventListener("change", () => {
      slot[fnKey] = currentValue();
      updateVisibility();
      onChanged();
    });
  }
  instSel.addEventListener("change", () => {
    populateActions();
    slot[fnKey] = currentValue();
    onChanged();
  });
  actSel.addEventListener("change", () => {
    slot[fnKey] = currentValue();
    populateActions();
    onChanged();
  });
  macroSel.addEventListener("change", () => {
    slot[fnKey] = currentValue();
    onChanged();
  });
  // Delegated (paramsBox's inputs are rebuilt on every populateActions())
  // rather than bound per-input - simpler than re-attaching a listener
  // every time renderFnParams() replaces the DOM nodes underneath it.
  paramsBox.addEventListener("change", (ev) => {
    const key = ev.target.dataset.fixedArgKey;
    if (!key) return;
    slot.fixedArgs = slot.fixedArgs || {};
    if (ev.target.value) slot.fixedArgs[key] = ev.target.value;
    else delete slot.fixedArgs[key];
    onChanged();
  });

  populateInstances();
  populateActions();
  populateMacros();
  updateVisibility();

  return {
    // Only re-renders this editor's own params box from the CURRENT
    // (already-set) instance/action selection - never touches
    // instSel/actSel/macroSel's value. This is what onSlotChanged calls
    // on every OTHER editor when one of them changes the shared
    // fixedArgs - a full refresh() there would re-derive instSel.value
    // from slot[fnKey], which is a real, confirmed bug when THIS same
    // editor is mid-selection (an instance picked but no action yet
    // means slot[fnKey] is still undefined, since currentValue()
    // requires both) - refresh() would reset the instance picker back to
    // empty the instant you picked it, before you ever got to choose a
    // function.
    refreshParams() {
      renderFnParams(paramsBox, slot, instSel.value, actSel.value);
    },
    refresh() {
      populateInstances();
      populateActions();
      populateMacros();
      updateVisibility();
    },
  };
}

// Same idea as buildFnEditor's action mode but for the slot's onState/
// levelState - independent Instance+State pickers (not tied to the
// matching function's instance), since which instance reports a state
// back doesn't have to be the same one a macro-bound On/Off actually
// calls. Kept explicit rather than inferred from a role tag for the same
// reason server.js's roleStatesForCategory exists: a hub manifest can
// have two states plausibly matching the same role (zone-hub's
// light.level vs its unrated climate.target).
function buildStateEditor(container, label, slot, stateKey, onChanged) {
  const wrap = document.createElement("div");
  wrap.className = "slot-fn-group";
  const labelEl = document.createElement("div");
  labelEl.className = "lbl";
  labelEl.textContent = label;
  const instSel = document.createElement("select");
  const stateSel = document.createElement("select");
  wrap.append(labelEl, instSel, stateSel);
  container.appendChild(wrap);

  function currentValue() {
    return instSel.value && stateSel.value ? { instanceId: instSel.value, stateId: stateSel.value } : undefined;
  }
  function populateInstances() {
    const ref = slot[stateKey];
    instSel.innerHTML =
      `<option value="">— instance —</option>` +
      instanceIds.map((id) => `<option value="${id}">${instanceLabel(id)} (${id})</option>`).join("");
    instSel.value = (ref && ref.instanceId) || "";
  }
  function populateStates() {
    const manifest = manifests.get(instSel.value);
    const ref = slot[stateKey];
    stateSel.innerHTML = `<option value="">— state —</option>` + (manifest ? manifest.states.map((s) => `<option value="${s.id}">${s.id} (${s.type})</option>`).join("") : "");
    stateSel.value = (ref && ref.stateId) || "";
  }
  instSel.addEventListener("change", () => {
    populateStates();
    slot[stateKey] = currentValue();
    onChanged();
  });
  stateSel.addEventListener("change", () => {
    slot[stateKey] = currentValue();
    onChanged();
  });
  populateInstances();
  populateStates();
  return {
    refresh() {
      populateInstances();
      populateStates();
    },
  };
}

// Builds one slot's expandable editor: Name, On/Off (function-or-macro)
// and Level (function-only) editors, On/Level state editors, a "Fixed
// arguments" box covering every non-"level" param across the slot's
// action-kind functions, and a zone/state-suffix field. Mutates `slot`
// in place; the caller persists bindingsCache after each change.
function buildSlotRow(cat, slot, onDelete, startExpanded) {
  const row = document.createElement("div");
  row.className = "slot-row";

  const header = document.createElement("div");
  header.className = "slot-row-header";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.value = slot.name || "";
  nameInput.placeholder = "Name (e.g. kitchen)";
  nameInput.addEventListener("click", (ev) => ev.stopPropagation());
  nameInput.addEventListener("change", () => {
    slot.name = nameInput.value.trim() || "Untitled";
    persistBindings();
  });
  const body = document.createElement("div");
  body.className = startExpanded ? "slot-row-body" : "slot-row-body hidden";
  const editBtn = document.createElement("button");
  editBtn.className = "btn small";
  editBtn.textContent = startExpanded ? "Close" : "Edit";
  editBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    body.classList.toggle("hidden");
    editBtn.textContent = body.classList.contains("hidden") ? "Edit" : "Close";
  });
  const delBtn = document.createElement("button");
  delBtn.className = "btn small danger";
  delBtn.textContent = "Delete";
  delBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    onDelete();
  });
  header.append(nameInput, editBtn, delBtn);

  // Zone/state suffix is a fallback for 0 or 2+ fixed arguments only - with
  // exactly one (the common case), it's the same raw value as that one
  // fixed argument and gets synced automatically by onSlotChanged below,
  // so there's nothing to separately type here.
  const suffixWrap = document.createElement("label");
  suffixWrap.innerHTML = `<span class="lbl">Zone / state suffix (only needed with 0 or 2+ fixed arguments)</span>`;
  const suffixInput = document.createElement("input");
  suffixInput.type = "text";
  suffixInput.value = slot.stateSuffix || "";
  suffixInput.addEventListener("change", () => {
    slot.stateSuffix = suffixInput.value.trim() || undefined;
    persistBindings();
  });
  suffixWrap.appendChild(suffixInput);

  // Every function editor shares the SAME slot.fixedArgs object (see
  // renderFnParams) - after any of them changes it, every editor needs
  // to re-render so a value picked in On's own box shows up in Off/
  // Level's boxes too, matching the "only fill it in once" behavior even
  // though the field now visually lives inside each function's own box
  // (QTI's actual layout) rather than one shared section.
  const fnEditors = [];
  function onSlotChanged() {
    fnEditors.forEach((e) => e.refreshParams());
    const keys = fixedParamKeysForSlot(slot);
    suffixWrap.style.display = keys.length === 1 ? "none" : "";
    if (keys.length === 1 && slot.fixedArgs && slot.fixedArgs[keys[0]]) {
      slot.stateSuffix = slot.fixedArgs[keys[0]];
      suffixInput.value = slot.fixedArgs[keys[0]];
    }
    persistBindings();
  }

  fnEditors.push(buildFnEditor(body, "On function", slot, "onFn", true, onSlotChanged));
  fnEditors.push(buildFnEditor(body, "Off function", slot, "offFn", true, onSlotChanged));
  fnEditors.push(buildFnEditor(body, "Level function", slot, "levelFn", false, onSlotChanged));
  body.appendChild(suffixWrap);
  buildStateEditor(body, "On state (for reading current on/off back)", slot, "onState", persistBindings);
  buildStateEditor(body, "Level state (for reading the current level back)", slot, "levelState", persistBindings);
  suffixWrap.style.display = fixedParamKeysForSlot(slot).length === 1 ? "none" : "";

  row.append(header, body);
  return row;
}

async function persistBindings() {
  const result = await saveBindings(bindingsCache);
  if (result.error) alert(result.error);
}

const CATEGORY_LABEL_PLURAL = {
  light: "Lights", switch: "Switches", security: "Securities", climate: "Climates", media: "Media", sensor: "Sensors", generic: "Generics",
};

function buildCategoryCard(cat) {
  const card = document.createElement("div");
  card.className = "card";
  card.dataset.defaultCollapsed = cat === "generic" ? "true" : "false";
  const h2 = document.createElement("h2");
  h2.textContent = `${CATEGORY_ICON[cat]} ${CATEGORY_LABEL_PLURAL[cat] || CATEGORY_LABEL[cat] + "s"}`;
  const addBtn = document.createElement("button");
  addBtn.className = "btn small";
  addBtn.style.marginLeft = "auto";
  addBtn.textContent = `+ Add ${CATEGORY_LABEL[cat]}`;
  addBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    // A freshly-added slot has nothing configured yet, so it starts
    // expanded - landing on a collapsed empty row after clicking "+ Add"
    // would just leave the admin hunting for how to open it, the exact
    // confusion an earlier version of this hit.
    bindingsCache[cat].push({ id: Math.random().toString(16).slice(2, 10), name: `New ${CATEGORY_LABEL[cat]}`, fixedArgs: {}, __justAdded: true });
    persistBindings();
    renderSlotList(cat, list);
  });
  h2.appendChild(addBtn);
  const list = document.createElement("div");
  list.id = `slotList-${cat}`;
  card.append(h2, list);
  renderSlotList(cat, list);
  return card;
}

function renderSlotList(cat, list) {
  list.innerHTML = "";
  const slots = bindingsCache[cat] || [];
  if (!slots.length) {
    list.innerHTML = `<p class="empty-hint">No ${(CATEGORY_LABEL_PLURAL[cat] || CATEGORY_LABEL[cat] + "s").toLowerCase()} yet - "+ Add ${CATEGORY_LABEL[cat]}" or Auto-generate above.</p>`;
    return;
  }
  slots.forEach((slot, i) => {
    const row = buildSlotRow(
      cat,
      slot,
      () => {
        bindingsCache[cat] = bindingsCache[cat].filter((s) => s !== slot);
        persistBindings();
        renderSlotList(cat, list);
      },
      i === slots.length - 1 && slot.__justAdded
    );
    delete slot.__justAdded;
    list.appendChild(row);
  });
}

async function renderDashboardTab() {
  const [bindings, macros, configs] = await Promise.all([
    getBindings(),
    listMacros(),
    Promise.all(instanceIds.map(async (id) => [id, await getConfig(id)])),
  ]);
  bindingsCache = bindings;
  macrosCache = macros;
  configByInstance = new Map(configs);
  const root = document.getElementById("bindingsCategoryCards");
  root.innerHTML = "";
  CATEGORY_ORDER.forEach((cat) => root.appendChild(buildCategoryCard(cat)));
  makeCardsCollapsible();
}
document.getElementById("autoGenBindingsBtn").addEventListener("click", async () => {
  const result = await autoGenerateBindings();
  if (result.error) {
    alert(result.error);
    return;
  }
  alert(result.added ? `Added ${result.added} slot(s).` : "Nothing new to add - every instance with a role-tagged on/off/level action already has a default slot.");
  renderDashboardTab();
});

// --- Health: per-instance running/error status + orchestrator uptime,
// ported in spirit from QTI's getHealthSnapshot/refreshHealthPanel. ---
async function renderHealthTab() {
  const listEl = document.getElementById("healthList");
  let data;
  try {
    data = await getHealth();
  } catch (err) {
    listEl.innerHTML = `<p class="empty-hint">Failed to load health: ${err.message}</p>`;
    return;
  }
  const uptimeMin = Math.floor(data.uptimeMs / 60000);
  const uptimeText = uptimeMin < 1 ? "just started" : `${uptimeMin} minute${uptimeMin === 1 ? "" : "s"} uptime`;
  listEl.innerHTML = `<p class="sub">orchestrator: ${uptimeText}</p>`;
  if (!data.health.length) {
    listEl.innerHTML += `<p class="empty-hint">No driver instances yet.</p>`;
    return;
  }
  const grid = document.createElement("div");
  grid.className = "tile-grid";
  data.health.forEach((h) => {
    const div = document.createElement("div");
    div.className = "tile";
    div.innerHTML = `
      <div class="tname">${h.running ? "🟢" : "🔴"} ${h.label}</div>
      <div class="tstate">${h.driverKey} · ${h.id}</div>
      ${h.lastError ? `<div style="margin-top:6px; font-size:.78rem; color:var(--bad);">${h.lastError}</div>` : ""}`;
    grid.appendChild(div);
  });
  listEl.appendChild(grid);
}
document.getElementById("healthRefreshBtn").addEventListener("click", (ev) => {
  ev.stopPropagation();
  renderHealthTab();
});

// --- Macro: named sequences of {instanceId, actionId, params}, run
// sequentially server-side. Step-picker UI walks the same manifest/action
// data already loaded for the Driver tab. ---
async function renderMacrosTab() {
  const listEl = document.getElementById("macrosList");
  const macros = await listMacros();
  if (!macros.length) {
    listEl.innerHTML = `<p class="empty-hint">No macros yet.</p>`;
  } else {
    listEl.innerHTML = "";
    macros.forEach((m) => {
      const row = document.createElement("div");
      row.className = "instance-row";
      row.innerHTML = `<div><div class="iname">${m.name}</div><div class="ikey">${m.steps.length} step${m.steps.length === 1 ? "" : "s"}</div></div>`;
      const btnRow = document.createElement("div");
      btnRow.className = "row";
      const runBtn = document.createElement("button");
      runBtn.className = "btn small primary";
      runBtn.textContent = "Run";
      runBtn.addEventListener("click", () => runMacro(m.id));
      const delBtn = document.createElement("button");
      delBtn.className = "btn small danger";
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", async () => {
        if (!confirm(`Delete macro "${m.name}"?`)) return;
        await deleteMacro(m.id);
        renderMacrosTab();
      });
      btnRow.append(runBtn, delBtn);
      row.appendChild(btnRow);
      listEl.appendChild(row);
    });
  }
}

function addMacroStepRow() {
  const stepsRoot = document.getElementById("macroSteps");
  const row = document.createElement("div");
  row.className = "row";
  row.style.marginBottom = "6px";
  const instSel = document.createElement("select");
  instSel.innerHTML = instanceIds.map((id) => `<option value="${id}">${instanceLabel(id)} (${id})</option>`).join("");
  const actionSel = document.createElement("select");
  function renderActions() {
    const manifest = manifests.get(instSel.value);
    actionSel.innerHTML = manifest.actions.map((a) => `<option value="${a.id}">${a.label}</option>`).join("");
  }
  instSel.addEventListener("change", renderActions);
  renderActions();
  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "btn small danger";
  removeBtn.textContent = "×";
  removeBtn.addEventListener("click", () => row.remove());
  row.append(instSel, actionSel, removeBtn);
  stepsRoot.appendChild(row);
}
document.getElementById("addMacroStepBtn").addEventListener("click", (ev) => {
  ev.stopPropagation();
  addMacroStepRow();
});
document.getElementById("add-macro-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const name = document.getElementById("macroName").value.trim();
  if (!name) return;
  const steps = [...document.getElementById("macroSteps").children].map((row) => {
    const [instSel, actionSel] = row.querySelectorAll("select");
    return { instanceId: instSel.value, actionId: actionSel.value, params: {} };
  });
  if (!steps.length) {
    alert("Add at least one step");
    return;
  }
  const result = await saveMacro({ name, steps });
  if (result.error) {
    alert(result.error);
    return;
  }
  document.getElementById("macroName").value = "";
  document.getElementById("macroSteps").innerHTML = "";
  renderMacrosTab();
});

// --- Camera: RTSP -> ffmpeg -> WS -> MSE, see camera-player.js and
// server.js's startCameraFfmpeg (ported directly from QTI). ---
let activePlayers = new Map(); // cameraId -> {stop()}
async function renderCameraTab() {
  const grid = document.getElementById("cameraGrid");
  activePlayers.forEach((p) => p.stop());
  activePlayers.clear();
  grid.innerHTML = "";
  const cams = await listCameras();
  if (!cams.length) {
    grid.innerHTML = `<p class="empty-hint">No cameras added yet.</p>`;
    return;
  }
  cams.forEach((cam) => {
    const wrap = document.createElement("div");
    wrap.className = "tile";
    wrap.style.cursor = "default";
    wrap.innerHTML = `
      <div class="row" style="justify-content:space-between;">
        <span class="tname">${cam.name}</span>
        <button class="btn small danger" type="button">Remove</button>
      </div>
      <video autoplay muted playsinline style="width:100%; aspect-ratio:16/9; background:#000; border-radius:8px; margin-top:6px; object-fit:contain;"></video>`;
    wrap.querySelector("button").addEventListener("click", async () => {
      if (!confirm(`Remove camera "${cam.name}"?`)) return;
      await deleteCamera(cam.id);
      renderCameraTab();
    });
    grid.appendChild(wrap);
    activePlayers.set(cam.id, attachCameraPlayer(wrap.querySelector("video"), cam.rtspUrl));
  });
}
document.getElementById("add-camera-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const name = document.getElementById("cameraName").value.trim();
  const rtspUrl = document.getElementById("cameraRtspUrl").value.trim();
  if (!name || !rtspUrl) return;
  const result = await addCamera(name, rtspUrl);
  if (result.error) {
    alert(result.error);
    return;
  }
  document.getElementById("cameraName").value = "";
  document.getElementById("cameraRtspUrl").value = "";
  renderCameraTab();
});

// --- 3D: upload-and-view only (see viewer3d.js for what's deliberately
// not ported from QTI's version - no device-mesh binding). Retried with
// backoff on init failure - a transient CDN hiccup fetching three.js
// shouldn't leave the tab permanently stuck with no explanation, the exact
// failure mode QTI's own initViewer3DWithRetry comment documents hitting. ---
const viewer3d = create3DViewer();
let viewer3dInited = false;
async function initViewer3DWithRetry(attempt) {
  attempt = attempt || 0;
  try {
    await viewer3d.init();
    viewer3dInited = true;
    const models = await listGlbModels();
    if (models.length) {
      document.getElementById("glbHint").style.display = "none";
      viewer3d.loadGLB(models[0].url);
    }
  } catch (e) {
    console.error(`3D viewer init failed (attempt ${attempt + 1}):`, e);
    if (attempt < 3) setTimeout(() => initViewer3DWithRetry(attempt + 1), 1500 * (attempt + 1));
  }
}
document.getElementById("glbUploadBtn").addEventListener("click", async () => {
  const input = document.getElementById("glbUploadInput");
  const file = input.files[0];
  if (!file) {
    alert("Pick a .glb file first");
    return;
  }
  const buf = await file.arrayBuffer();
  const dataBase64 = btoa(new Uint8Array(buf).reduce((s, b) => s + String.fromCharCode(b), ""));
  const result = await uploadGlb(file.name, dataBase64);
  if (result.error) {
    alert(result.error);
    return;
  }
  document.getElementById("glbHint").style.display = "none";
  if (!viewer3dInited) await initViewer3DWithRetry();
  viewer3d.loadGLB(result.url);
});

async function fullRefresh() {
  const list = await listInstances();
  instanceIds = list.map((s) => s.id);
  await Promise.all(
    list.map(async (summary) => {
      if (!manifests.has(summary.id)) manifests.set(summary.id, await getManifest(summary.id));
      runningByInstance.set(summary.id, summary.running);
      labelByInstance.set(summary.id, summary.label);
      statesByInstance.set(summary.id, await getState(summary.id));
    })
  );
  updateCountPill();
  renderInstancesList();
  renderActivePanel();
  // Dashboard is a local editor now (bindings.json), not a live-state view
  // - it deliberately does NOT re-render on every poll tick the way it
  // used to, since that would blow away an in-progress edit out from
  // under the admin. It (re)loads once when the tab is opened instead.
  const mainTab = activeMainTab();
  if (mainTab === "health") renderHealthTab();
}

// Category first, then driver (filtered to that category) - a flat driver
// list gets unwieldy as the library grows, and the category is usually
// the thing an installer actually knows going in ("I'm adding a light",
// not "I'm adding an http-relay").
// --- Uploaded drivers: manifest.json + driver.js as plain text (Oak has
// no packaging/encryption step at all yet, unlike an .rtidriver) - ported
// in spirit from QTI's own "Uploaded drivers" card (per-driver Delete
// button, added after that project repeatedly needed a shell + manual rm
// to clean up re-uploads). Deleting a driver a running instance still
// uses, or one of Oak's own 4 built-in drivers, is rejected server-side
// with a clear reason rather than silently refused here. ---
async function renderUploadedDriversList() {
  const listEl = document.getElementById("uploadedDriversList");
  const drivers = await listDrivers();
  if (!drivers.length) {
    listEl.innerHTML = `<p class="empty-hint">No drivers found.</p>`;
    return;
  }
  listEl.innerHTML = "";
  drivers.forEach((d) => {
    const row = document.createElement("div");
    row.className = "instance-row";
    row.innerHTML = `<div><div class="iname">${d.displayName}</div><div class="ikey">${d.id}</div></div>`;
    const delBtn = document.createElement("button");
    delBtn.className = "btn small danger";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", async () => {
      if (!confirm(`Delete driver "${d.displayName}" permanently? The files are removed from disk.`)) return;
      const result = await deleteDriverPackage(d.id);
      if (result.error) {
        alert(result.error);
        return;
      }
      renderUploadedDriversList();
    });
    row.appendChild(delBtn);
    listEl.appendChild(row);
  });
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsText(file);
  });
}
document.getElementById("upload-driver-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const driverId = document.getElementById("uploadDriverId").value.trim();
  const manifestFile = document.getElementById("uploadManifestFile").files[0];
  const driverJsFile = document.getElementById("uploadDriverJsFile").files[0];
  if (!driverId || !manifestFile || !driverJsFile) {
    alert("Driver id, manifest.json, and driver.js are all required");
    return;
  }
  const [manifestJson, driverJs] = await Promise.all([readFileAsText(manifestFile), readFileAsText(driverJsFile)]);
  const result = await uploadDriver(driverId, manifestJson, driverJs);
  if (result.error) {
    alert(result.error);
    return;
  }
  if (result.inferredCategory) {
    alert(`Uploaded. No category was declared in manifest.json, so it was guessed as "${result.inferredCategory}" from its action roles - edit manifest.json and re-upload to change it.`);
  }
  document.getElementById("uploadDriverId").value = "";
  document.getElementById("uploadManifestFile").value = "";
  document.getElementById("uploadDriverJsFile").value = "";
  renderUploadedDriversList();
});

async function setupAddInstanceForm() {
  const drivers = await listDrivers();
  const fieldsRoot = document.getElementById("add-instance-fields");

  function configFieldInput(prefix, f) {
    if (f.type === "keyvalue") return keyValueFieldPlaceholder(prefix, f);
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
      <input name="id" placeholder="instance id (e.g. relay2 - letters/numbers/hyphens only, no spaces)" pattern="[A-Za-z0-9_-]+" title="Letters, numbers, hyphens, or underscores only - no spaces" required />
      <input name="label" placeholder="Label (optional, to tell instances apart, e.g. Kitchen Eisy)" />
      ${connFields}
      ${settingFields}
      <button class="btn small primary" type="submit">Add</button>`;
    (manifest.connection.options[0].fields || []).forEach((f) => f.type === "keyvalue" && wireKeyValueField(fieldsRoot, "connection", f));
    (manifest.settings || []).forEach((f) => f.type === "keyvalue" && wireKeyValueField(fieldsRoot, "settings", f));
  }

  function driversInCategory(cat) {
    if (cat === "__all__") return drivers;
    return drivers.filter((d) => effectiveCategories(d).includes(cat));
  }
  function renderDriverOptionsFor(cat) {
    const filtered = driversInCategory(cat);
    driverPicker.innerHTML = filtered.map((d) => `<option value="${d.id}">${d.displayName}</option>`).join("");
    renderFieldsFor(driverPicker.value);
  }

  const presentCats = CATEGORY_ORDER.filter((c) => drivers.some((d) => effectiveCategories(d).includes(c)));
  const categoryPicker = document.createElement("select");
  categoryPicker.innerHTML =
    `<option value="__all__">All categories</option>` +
    presentCats.map((c) => `<option value="${c}">${CATEGORY_ICON[c]} ${CATEGORY_LABEL[c]}</option>`).join("");
  categoryPicker.addEventListener("change", () => renderDriverOptionsFor(categoryPicker.value));

  const driverPicker = document.createElement("select");
  driverPicker.name = "driver";
  driverPicker.addEventListener("change", () => renderFieldsFor(driverPicker.value));

  fieldsRoot.before(categoryPicker, driverPicker);
  renderDriverOptionsFor("__all__");

  document.getElementById("add-instance-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const form = ev.target;
    const id = form.querySelector('[name="id"]').value.trim();
    const label = form.querySelector('[name="label"]').value.trim();
    const connection = { transport: drivers.find((d) => d.id === driverPicker.value).connection.options[0].transport };
    const settings = {};
    form.querySelectorAll("input").forEach((input) => {
      if (input.name === "id" || input.name === "label" || input.value === "" || input.closest("[data-keyvalue-field]")) return;
      const [group, key] = input.name.split(".");
      const value = input.type === "number" ? Number(input.value) : input.value;
      if (group === "connection") connection[key] = value;
      else if (group === "settings") settings[key] = value;
    });
    collectKeyValueFields(form, connection, settings);
    if (!id) return;
    const result = await addInstance(id, driverPicker.value, connection, settings, label);
    if (result.error) {
      alert(result.error);
      return;
    }
    form.querySelectorAll("input").forEach((input) => (input.value = ""));
    document.querySelector('.card[data-default-collapsed] h2')?.closest(".card").__setCollapsed(true);
    fullRefresh();
  });
}

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(fullRefresh, REFRESH_DEBOUNCE_MS);
}

makeCardsCollapsible();
setupAddInstanceForm();
renderUploadedDriversList();
connectLiveSocket((msg) => {
  if (msg.type === "event") {
    logLine(msg.instanceId, `[event] ${msg.event.id} ${JSON.stringify(msg.event.params)}`);
  } else if (msg.type === "state") {
    logLine(msg.instanceId, `[state] ${msg.state.id}${msg.state.instanceKey !== undefined ? "#" + msg.state.instanceKey : ""} = ${msg.state.value}`);
  }
  scheduleRefresh();
});
setInterval(fullRefresh, FALLBACK_POLL_MS);

// A cold #dashboard (or any other tab) direct link/bookmark must wait for
// the FIRST fullRefresh() to populate manifests/instanceIds before
// activating - the Dashboard slot editor reads them synchronously while
// building each function's Instance/Function selects, and a page loaded
// straight into that tab would otherwise render every dropdown empty
// (manifests.get(id) returning undefined for an instance that genuinely
// exists, just not fetched yet) - a real, hit-in-practice race, not
// hypothetical.
fullRefresh().then(() => {
  if (location.hash.slice(1)) activateMainTab(location.hash.slice(1));
});
