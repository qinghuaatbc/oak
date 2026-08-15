import {
  listInstances, getManifest, getState, callAction, listDrivers, addInstance, deleteInstance,
  getConfig, editInstance, stopInstance, startInstance,
  getHealth, listMacros, saveMacro, deleteMacro, runMacro,
  listAutomations, saveAutomation, deleteAutomation, runAutomation,
  getSettings, saveSettings,
  listCameras, addCamera, deleteCamera, uploadGlb, uploadImage,
  uploadDriver, deleteDriverPackage,
  getBindings, saveBindings, autoGenerateBindings,
} from "./api.js";
import { connectLiveSocket } from "./live-socket.js";
import { attachCameraPlayer } from "./camera-player.js";
import { create3DViewer } from "./viewer3d.js";
import {
  CATEGORY_ICON,
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  effectiveCategories,
  getOnOffPair,
  ANIM_TYPES,
  AXIS_ANIM_TYPES,
  bindingSlot,
  resolveMeshOnLevel as resolveMeshOnLevelShared,
  callFn as callFnShared,
  createGlbProgressHandler,
} from "./roles.js";

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
        // Blindly clearing to "" on expand assumes every card child has no
        // deliberate inline `display` of its own (true for a plain <p>/
        // <form>, false for a flex/grid wrapper like Layout's palette+
        // canvas row) - snapshot whatever was there BEFORE this function
        // ever touched it, once, and restore exactly that on expand
        // instead of guessing "" is always safe.
        if (child.dataset.origDisplay === undefined) child.dataset.origDisplay = child.style.display || "";
        child.style.display = collapsed ? "none" : child.dataset.origDisplay;
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

// Same tile-grid language as Uploaded Drivers / Add Instance's driver
// picker - a running instance gets its driver's own icon, plus an on/off-
// style ring (via the existing .tile[data-on] convention... no such
// convention here, so a simple border/opacity cue on .stopped) instead of
// the flat instance-row list.
function renderInstancesList() {
  instancesListEl.className = "tile-grid tile-grid-3col";
  instancesListEl.innerHTML = "";
  if (!instanceIds.length) {
    instancesListEl.innerHTML = `<p class="empty-hint">No driver instances yet.</p>`;
    return;
  }
  instanceIds.forEach((id) => {
    const manifest = manifests.get(id);
    const running = runningByInstance.get(id);
    const cat = effectiveCategories(manifest)[0];
    const tile = document.createElement("div");
    tile.className = "tile" + (running ? " running" : " stopped");
    tile.style.cssText = "text-align:center;";
    tile.title = "Click to view/edit this instance in State/Actions/Events/Config";
    tile.innerHTML = `
      <div style="font-size:28px;">${manifest.icon || CATEGORY_ICON[cat] || "⚙️"}</div>
      <div class="tname" style="margin-top:6px;">${instanceLabel(id)}${running ? "" : ' <span class="istatus">stopped</span>'}</div>
      <div class="tstate">${manifest.id} · ${id}</div>`;
    tile.addEventListener("click", () => {
      instanceFilter.value = id;
      renderActivePanel({ allowConfigRerender: true });
    });
    const btnRow = document.createElement("div");
    btnRow.className = "row";
    btnRow.style.cssText = "justify-content:center; margin-top:10px;";

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

    tile.appendChild(btnRow);
    instancesListEl.appendChild(tile);
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
  else if (page === "automation") renderAutomationsTab();
  else if (page === "health") renderHealthTab();
  else if (page === "camera") renderCameraTab();
  else if (page === "3d") open3DTab();
  else if (page === "layout") openLayoutTab();
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
    if (!confirm(`Delete "${slot.name || "this"}"?`)) return;
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
// ---------------------------------------------------------------------
// Shared builders for Macro/Automation forms - a macro step's "action"
// type, an automation's action, a condition row, and a trigger are the
// same underlying shapes in both features (see server.js's header
// comments on `macros`/`automations`), so one implementation of each
// backs both UIs rather than two copies drifting apart.
// ---------------------------------------------------------------------

// Instance + action + per-param inputs (sourced from the action's own
// manifest.params, same {key,type,label,default} shape the Add Instance
// form already reads) - used for a macro's "action" step and an
// automation's direct-call action.
function buildActionPicker(container, initial) {
  const instSel = document.createElement("select");
  instSel.innerHTML = instanceIds.map((id) => `<option value="${id}">${instanceLabel(id)} (${id})</option>`).join("");
  const actionSel = document.createElement("select");
  const paramsBox = document.createElement("div");
  paramsBox.style.marginTop = "4px";

  function renderActions() {
    const manifest = manifests.get(instSel.value);
    actionSel.innerHTML = (manifest ? manifest.actions : []).map((a) => `<option value="${a.id}">${a.label}</option>`).join("");
    if (initial && initial.actionId) actionSel.value = initial.actionId;
  }
  function renderParams() {
    const manifest = manifests.get(instSel.value);
    const action = manifest && manifest.actions.find((a) => a.id === actionSel.value);
    const params = (action && action.params) || [];
    const preset = initial && initial.actionId === actionSel.value ? initial.params : undefined;
    paramsBox.innerHTML = params
      .map((p) => {
        const val = preset && preset[p.key] !== undefined ? preset[p.key] : p.default !== undefined ? p.default : "";
        return `<label><span class="lbl">${p.label || p.key}</span><input data-param-key="${p.key}" type="${p.type === "number" ? "number" : "text"}" value="${val}" /></label>`;
      })
      .join("");
  }
  instSel.addEventListener("change", () => {
    renderActions();
    renderParams();
  });
  actionSel.addEventListener("change", renderParams);
  if (initial && initial.instanceId) instSel.value = initial.instanceId;
  renderActions();
  renderParams();

  const row = document.createElement("div");
  row.className = "row";
  row.append(instSel, actionSel);
  container.append(row, paramsBox);

  return {
    getValue() {
      const params = {};
      paramsBox.querySelectorAll("[data-param-key]").forEach((input) => {
        params[input.dataset.paramKey] = input.type === "number" ? Number(input.value) : input.value;
      });
      return { instanceId: instSel.value, actionId: actionSel.value, params };
    },
  };
}

// A list of {instanceId, stateId, stateSuffix, op, value} rows, AND'd
// together - used for an automation's/macro's own conditions AND a
// macro condition-step's nested conditions. stateSuffix is always a
// plain text input (not a friendly-name dropdown, unlike the Dashboard
// slot editor's device-name picker) - condition authoring is a less-
// common, power-user path where the raw suffix value is an acceptable
// ask, not worth a second elaborate resolver for.
function buildConditionListEditor(rowsContainer, initialConditions) {
  function addRow(cond) {
    cond = cond || {};
    const row = document.createElement("div");
    row.className = "row";
    row.style.marginBottom = "6px";
    const instSel = document.createElement("select");
    instSel.className = "cond-inst";
    instSel.innerHTML = instanceIds.map((id) => `<option value="${id}">${instanceLabel(id)} (${id})</option>`).join("");
    const stateSel = document.createElement("select");
    stateSel.className = "cond-state";
    function renderStates() {
      const manifest = manifests.get(instSel.value);
      stateSel.innerHTML = (manifest ? manifest.states : []).map((s) => `<option value="${s.id}">${s.id}</option>`).join("");
      if (cond.stateId) stateSel.value = cond.stateId;
    }
    instSel.addEventListener("change", renderStates);
    if (cond.instanceId) instSel.value = cond.instanceId;
    renderStates();
    const suffixInput = document.createElement("input");
    suffixInput.className = "cond-suffix";
    suffixInput.placeholder = "suffix (optional)";
    suffixInput.value = cond.stateSuffix || "";
    suffixInput.style.width = "120px";
    const opSel = document.createElement("select");
    opSel.className = "cond-op";
    opSel.innerHTML = ["==", "!=", ">", "<", ">=", "<="].map((op) => `<option value="${op}"${cond.op === op ? " selected" : ""}>${op}</option>`).join("");
    const valInput = document.createElement("input");
    valInput.className = "cond-value";
    valInput.placeholder = "value";
    valInput.value = cond.value !== undefined ? cond.value : "";
    valInput.style.width = "90px";
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "btn small danger";
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", () => row.remove());
    row.append(instSel, stateSel, suffixInput, opSel, valInput, removeBtn);
    rowsContainer.appendChild(row);
  }
  (initialConditions || []).forEach(addRow);
  return {
    addRow: () => addRow(),
    getValue() {
      return [...rowsContainer.children].map((row) => ({
        instanceId: row.querySelector(".cond-inst").value,
        stateId: row.querySelector(".cond-state").value,
        stateSuffix: row.querySelector(".cond-suffix").value.trim() || undefined,
        op: row.querySelector(".cond-op").value,
        value: row.querySelector(".cond-value").value,
      }));
    },
  };
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// "Manual only" / "on event" / "at a time" - the same trigger shape an
// automation and a self-triggering macro both use (see server.js's
// checkTimeAutomations/runEventAutomations/runEventMacros). Time mode
// adds sunrise/sunset (+/- offset minutes) on top of a fixed HH:MM, and
// an optional day-of-week filter (all 7 checked = every day).
function buildTriggerEditor(container, initial) {
  const typeSel = document.createElement("select");
  typeSel.innerHTML = `<option value="">Manual only</option><option value="event">On event</option><option value="time">At a time</option>`;
  typeSel.value = initial && initial.type ? initial.type : "";
  const sub = document.createElement("div");
  sub.style.marginTop = "6px";
  container.append(typeSel, sub);

  function renderSub() {
    sub.innerHTML = "";
    if (typeSel.value === "event") {
      const instSel = document.createElement("select");
      instSel.className = "trig-inst";
      instSel.innerHTML = instanceIds.map((id) => `<option value="${id}">${instanceLabel(id)} (${id})</option>`).join("");
      const eventSel = document.createElement("select");
      eventSel.className = "trig-event";
      function renderEvents() {
        const manifest = manifests.get(instSel.value);
        eventSel.innerHTML = (manifest ? manifest.events : []).map((e) => `<option value="${e.id}">${e.label || e.id}</option>`).join("");
        if (initial && initial.eventId) eventSel.value = initial.eventId;
      }
      instSel.addEventListener("change", renderEvents);
      if (initial && initial.instanceId) instSel.value = initial.instanceId;
      renderEvents();
      const row = document.createElement("div");
      row.className = "row";
      row.append(instSel, eventSel);
      sub.appendChild(row);
    } else if (typeSel.value === "time") {
      const timeInput = document.createElement("input");
      timeInput.type = "time";
      timeInput.className = "trig-time";
      timeInput.value = (initial && initial.time) || "18:00";
      const modeSel = document.createElement("select");
      modeSel.className = "trig-mode";
      modeSel.innerHTML = `<option value="fixed">Fixed time</option><option value="sunrise">Sunrise</option><option value="sunset">Sunset</option>`;
      modeSel.value = (initial && initial.mode) || "fixed";
      const offsetInput = document.createElement("input");
      offsetInput.type = "number";
      offsetInput.className = "trig-offset";
      offsetInput.placeholder = "offset minutes (+/-)";
      offsetInput.value = (initial && initial.offsetMin) || 0;
      function syncTimeMode() {
        timeInput.style.display = modeSel.value === "fixed" ? "" : "none";
        offsetInput.style.display = modeSel.value === "fixed" ? "none" : "";
      }
      modeSel.addEventListener("change", syncTimeMode);
      syncTimeMode();
      const row = document.createElement("div");
      row.className = "row";
      row.append(timeInput, modeSel, offsetInput);

      const daysRow = document.createElement("div");
      daysRow.className = "row";
      daysRow.style.marginTop = "6px";
      const initialDays = initial && Array.isArray(initial.days) ? initial.days : [0, 1, 2, 3, 4, 5, 6];
      DAY_LABELS.forEach((label, i) => {
        const lbl = document.createElement("label");
        lbl.style.cssText = "display:flex; align-items:center; gap:4px;";
        lbl.innerHTML = `<input type="checkbox" class="trig-day" value="${i}" ${initialDays.includes(i) ? "checked" : ""}/> ${label}`;
        daysRow.appendChild(lbl);
      });
      sub.append(row, daysRow);
    }
  }
  typeSel.addEventListener("change", renderSub);
  renderSub();

  return {
    getValue() {
      if (!typeSel.value) return undefined;
      if (typeSel.value === "event") {
        const instSel = sub.querySelector(".trig-inst");
        const eventSel = sub.querySelector(".trig-event");
        if (!instSel || !eventSel || !eventSel.value) return undefined;
        return { type: "event", instanceId: instSel.value, eventId: eventSel.value };
      }
      const days = [...sub.querySelectorAll(".trig-day:checked")].map((c) => Number(c.value));
      return {
        type: "time",
        time: sub.querySelector(".trig-time").value || "00:00",
        mode: sub.querySelector(".trig-mode").value,
        offsetMin: Number(sub.querySelector(".trig-offset").value) || 0,
        days,
      };
    },
  };
}
function describeTrigger(trigger) {
  if (!trigger) return "manual only";
  if (trigger.type === "event") return `on ${instanceLabel(trigger.instanceId)} → ${trigger.eventId}`;
  if (trigger.type === "time") {
    const modeText = trigger.mode === "sunrise" ? "sunrise" : trigger.mode === "sunset" ? "sunset" : trigger.time;
    const offsetText = trigger.mode && trigger.mode !== "fixed" && trigger.offsetMin ? ` ${trigger.offsetMin > 0 ? "+" : ""}${trigger.offsetMin}min` : "";
    const daysText = Array.isArray(trigger.days) && trigger.days.length < 7 ? ` (${trigger.days.map((d) => DAY_LABELS[d]).join(",")})` : "";
    return `at ${modeText}${offsetText}${daysText}`;
  }
  return "manual only";
}

// A macro step list, recursive - a "condition" step's then/else branches
// are themselves step lists built by calling this function again, so
// nested branching costs no extra code beyond the top-level case. Steps
// are ordinary DOM children of `container`, read back in DOM order at
// getValue() time (add/remove-by-DOM-manipulation, same convention the
// keyvalue settings editor already uses) - no parallel array to keep in
// sync.
function buildStepList(container, initialSteps) {
  function addStep(initialStep) {
    let step = initialStep || { type: "action" };
    const box = document.createElement("div");
    box.className = "card";
    box.style.cssText = "margin-bottom:8px; padding:10px;";
    const typeSel = document.createElement("select");
    typeSel.innerHTML = `<option value="action">Call action</option><option value="condition">If/else</option><option value="delay">Delay</option>`;
    typeSel.value = step.type;
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "btn small danger";
    removeBtn.textContent = "Remove step";
    removeBtn.addEventListener("click", () => box.remove());
    const headerRow = document.createElement("div");
    headerRow.className = "row";
    headerRow.append(typeSel, removeBtn);
    const body = document.createElement("div");
    body.style.marginTop = "6px";
    box.append(headerRow, body);
    container.appendChild(box);

    let actionPicker = null;
    let conditionEditor = null;
    let thenList = null;
    let elseList = null;

    function renderBody() {
      body.innerHTML = "";
      actionPicker = conditionEditor = thenList = elseList = null;
      if (typeSel.value === "action") {
        actionPicker = buildActionPicker(body, step.type === "action" ? step : undefined);
      } else if (typeSel.value === "condition") {
        const condLbl = document.createElement("div");
        condLbl.className = "lbl";
        condLbl.textContent = "Conditions";
        const condRows = document.createElement("div");
        body.append(condLbl, condRows);
        conditionEditor = buildConditionListEditor(condRows, step.type === "condition" ? step.conditions : undefined);
        const addCondBtn = document.createElement("button");
        addCondBtn.type = "button";
        addCondBtn.className = "btn small";
        addCondBtn.textContent = "+ Add condition";
        addCondBtn.addEventListener("click", () => conditionEditor.addRow());
        body.appendChild(addCondBtn);

        const thenLbl = document.createElement("div");
        thenLbl.className = "lbl";
        thenLbl.style.marginTop = "8px";
        thenLbl.textContent = "Then";
        const thenBox = document.createElement("div");
        body.append(thenLbl, thenBox);
        thenList = buildStepList(thenBox, step.type === "condition" ? step.then : undefined);
        const addThenBtn = document.createElement("button");
        addThenBtn.type = "button";
        addThenBtn.className = "btn small";
        addThenBtn.textContent = "+ Add then-step";
        addThenBtn.addEventListener("click", () => thenList.addStep());
        body.appendChild(addThenBtn);

        const elseLbl = document.createElement("div");
        elseLbl.className = "lbl";
        elseLbl.style.marginTop = "8px";
        elseLbl.textContent = "Else";
        const elseBox = document.createElement("div");
        body.append(elseLbl, elseBox);
        elseList = buildStepList(elseBox, step.type === "condition" ? step.else : undefined);
        const addElseBtn = document.createElement("button");
        addElseBtn.type = "button";
        addElseBtn.className = "btn small";
        addElseBtn.textContent = "+ Add else-step";
        addElseBtn.addEventListener("click", () => elseList.addStep());
        body.appendChild(addElseBtn);
      } else if (typeSel.value === "delay") {
        const msInput = document.createElement("input");
        msInput.type = "number";
        msInput.className = "delay-ms";
        msInput.placeholder = "milliseconds";
        msInput.value = step.type === "delay" && step.ms !== undefined ? step.ms : 1000;
        body.appendChild(msInput);
      }
    }
    typeSel.addEventListener("change", () => {
      step = { type: typeSel.value };
      renderBody();
    });
    renderBody();

    box.__getStep = () => {
      if (typeSel.value === "action") return { type: "action", ...actionPicker.getValue() };
      if (typeSel.value === "condition") return { type: "condition", conditions: conditionEditor.getValue(), then: thenList.getValue(), else: elseList.getValue() };
      if (typeSel.value === "delay") return { type: "delay", ms: Number(body.querySelector(".delay-ms").value) || 0 };
      return null;
    };
  }
  (initialSteps || []).forEach(addStep);
  return {
    addStep: () => addStep(),
    getValue() {
      return [...container.children].map((box) => box.__getStep()).filter(Boolean);
    },
  };
}

// ---------------------------------------------------------------------
// Macros
// ---------------------------------------------------------------------
let macroTriggerEditor = null;
let macroConditionsEditor = null;
let macroStepsList = null;
let editingMacroId = null;

function resetMacroForm(macro) {
  editingMacroId = macro ? macro.id : null;
  document.getElementById("macroFormTitle").textContent = macro ? `Edit macro "${macro.name}"` : "Add macro";
  document.getElementById("macroName").value = macro ? macro.name : "";
  document.getElementById("cancelMacroEditBtn").style.display = macro ? "" : "none";

  const triggerBox = document.getElementById("macroTrigger");
  triggerBox.innerHTML = "";
  macroTriggerEditor = buildTriggerEditor(triggerBox, macro && macro.trigger);

  const condBox = document.getElementById("macroConditions");
  condBox.innerHTML = "";
  macroConditionsEditor = buildConditionListEditor(condBox, macro && macro.conditions);

  const stepsBox = document.getElementById("macroSteps");
  stepsBox.innerHTML = "";
  macroStepsList = buildStepList(stepsBox, macro && macro.steps);
}

async function renderMacrosTab() {
  const listEl = document.getElementById("macrosList");
  const macroList = await listMacros();
  if (!macroList.length) {
    listEl.innerHTML = `<p class="empty-hint">No macros yet.</p>`;
  } else {
    listEl.innerHTML = "";
    macroList.forEach((m) => {
      const row = document.createElement("div");
      row.className = "instance-row";
      row.innerHTML = `<div><div class="iname">${m.name}</div><div class="ikey">${m.steps.length} step${m.steps.length === 1 ? "" : "s"} · ${describeTrigger(m.trigger)}</div></div>`;
      const btnRow = document.createElement("div");
      btnRow.className = "row";
      const runBtn = document.createElement("button");
      runBtn.className = "btn small primary";
      runBtn.textContent = "Run";
      runBtn.addEventListener("click", () => runMacro(m.id));
      const editBtn = document.createElement("button");
      editBtn.className = "btn small";
      editBtn.textContent = "Edit";
      editBtn.addEventListener("click", () => resetMacroForm(m));
      const delBtn = document.createElement("button");
      delBtn.className = "btn small danger";
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", async () => {
        if (!confirm(`Delete macro "${m.name}"?`)) return;
        await deleteMacro(m.id);
        if (editingMacroId === m.id) resetMacroForm(null);
        renderMacrosTab();
      });
      btnRow.append(runBtn, editBtn, delBtn);
      row.appendChild(btnRow);
      listEl.appendChild(row);
    });
  }
  // Rebuilds the add-form's instance/action/event dropdowns against
  // whatever instanceIds/manifests currently hold - this tab can be
  // opened before fullRefresh() has ever populated those (a real,
  // hit-in-practice race the Dashboard tab's own hash-race fix already
  // dealt with once this session), so the form needs a fresh build on
  // every visit, not just once at module load. Skipped mid-edit so
  // switching away and back doesn't silently drop an in-progress edit.
  if (!editingMacroId) resetMacroForm(null);
}

document.getElementById("addMacroConditionBtn").addEventListener("click", (ev) => {
  ev.stopPropagation();
  macroConditionsEditor.addRow();
});
document.getElementById("addMacroStepBtn").addEventListener("click", (ev) => {
  ev.stopPropagation();
  macroStepsList.addStep();
});
document.getElementById("cancelMacroEditBtn").addEventListener("click", () => resetMacroForm(null));
document.getElementById("add-macro-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const name = document.getElementById("macroName").value.trim();
  if (!name) return;
  const steps = macroStepsList.getValue();
  if (!steps.length) {
    alert("Add at least one step");
    return;
  }
  const trigger = macroTriggerEditor.getValue();
  const conditions = macroConditionsEditor.getValue();
  const result = await saveMacro({ id: editingMacroId || undefined, name, steps, trigger, conditions: conditions.length ? conditions : undefined });
  if (result.error) {
    alert(result.error);
    return;
  }
  resetMacroForm(null);
  renderMacrosTab();
});

// ---------------------------------------------------------------------
// Automation: single action (or a whole macro) gated by trigger+
// conditions - see server.js's `automations` header comment for the
// exact shape. Shares buildTriggerEditor/buildConditionListEditor with
// the macro form above so the two features stay in lockstep.
// ---------------------------------------------------------------------
function buildAutomationActionEditor(container, initial) {
  const kindSel = document.createElement("select");
  kindSel.innerHTML = `<option value="action">Call one action</option><option value="macro">Run a macro</option>`;
  kindSel.value = initial && initial.kind === "macro" ? "macro" : "action";
  const sub = document.createElement("div");
  sub.style.marginTop = "6px";
  container.append(kindSel, sub);

  let actionPicker = null;
  let macroSel = null;

  async function renderSub() {
    sub.innerHTML = "";
    if (kindSel.value === "macro") {
      macroSel = document.createElement("select");
      const macroList = await listMacros();
      if (!macroList.length) {
        sub.innerHTML = `<p class="empty-hint">No macros yet - add one on the Macros tab first.</p>`;
        macroSel = null;
        return;
      }
      macroSel.innerHTML = macroList.map((m) => `<option value="${m.id}">${m.name}</option>`).join("");
      if (initial && initial.macroId) macroSel.value = initial.macroId;
      sub.appendChild(macroSel);
    } else {
      actionPicker = buildActionPicker(sub, initial && initial.kind !== "macro" ? initial : undefined);
    }
  }
  kindSel.addEventListener("change", renderSub);
  renderSub();

  container.__getAutomationAction = () => {
    if (kindSel.value === "macro") return macroSel ? { kind: "macro", macroId: macroSel.value } : undefined;
    return { kind: "action", ...actionPicker.getValue() };
  };
}
function describeAction(action) {
  if (!action) return "";
  if (action.kind === "macro") return "run macro";
  return `${instanceLabel(action.instanceId)} → ${action.actionId}`;
}

let automationTriggerEditor = null;
let automationConditionsEditor = null;
let editingAutomationId = null;

function resetAutomationForm(auto) {
  editingAutomationId = auto ? auto.id : null;
  document.getElementById("automationFormTitle").textContent = auto ? `Edit automation "${auto.name}"` : "Add automation";
  document.getElementById("automationName").value = auto ? auto.name : "";
  document.getElementById("cancelAutomationEditBtn").style.display = auto ? "" : "none";

  const triggerBox = document.getElementById("automationTrigger");
  triggerBox.innerHTML = "";
  automationTriggerEditor = buildTriggerEditor(triggerBox, auto && auto.trigger);

  const condBox = document.getElementById("automationConditions");
  condBox.innerHTML = "";
  automationConditionsEditor = buildConditionListEditor(condBox, auto && auto.conditions);

  const actionBox = document.getElementById("automationAction");
  actionBox.innerHTML = "";
  buildAutomationActionEditor(actionBox, auto && auto.action);
}

async function renderAutomationsTab() {
  const listEl = document.getElementById("automationsList");
  const autos = await listAutomations();
  if (!autos.length) {
    listEl.innerHTML = `<p class="empty-hint">No automations yet.</p>`;
  } else {
    listEl.innerHTML = "";
    autos.forEach((a) => {
      const row = document.createElement("div");
      row.className = "instance-row";
      row.innerHTML = `<div><div class="iname">${a.name}</div><div class="ikey">${describeTrigger(a.trigger)} → ${describeAction(a.action)}</div></div>`;
      const btnRow = document.createElement("div");
      btnRow.className = "row";
      const runBtn = document.createElement("button");
      runBtn.className = "btn small primary";
      runBtn.textContent = "Test fire";
      runBtn.addEventListener("click", () => runAutomation(a.id));
      const editBtn = document.createElement("button");
      editBtn.className = "btn small";
      editBtn.textContent = "Edit";
      editBtn.addEventListener("click", () => resetAutomationForm(a));
      const delBtn = document.createElement("button");
      delBtn.className = "btn small danger";
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", async () => {
        if (!confirm(`Delete automation "${a.name}"?`)) return;
        await deleteAutomation(a.id);
        if (editingAutomationId === a.id) resetAutomationForm(null);
        renderAutomationsTab();
      });
      btnRow.append(runBtn, editBtn, delBtn);
      row.appendChild(btnRow);
      listEl.appendChild(row);
    });
  }
  const s = await getSettings();
  document.getElementById("settingsLat").value = s.latitude !== undefined ? s.latitude : "";
  document.getElementById("settingsLon").value = s.longitude !== undefined ? s.longitude : "";
  // Same cold-start reasoning as renderMacrosTab's own rebuild - see its comment.
  if (!editingAutomationId) resetAutomationForm(null);
}

document.getElementById("addAutomationConditionBtn").addEventListener("click", (ev) => {
  ev.stopPropagation();
  automationConditionsEditor.addRow();
});
document.getElementById("cancelAutomationEditBtn").addEventListener("click", () => resetAutomationForm(null));
document.getElementById("add-automation-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const name = document.getElementById("automationName").value.trim();
  if (!name) return;
  const trigger = automationTriggerEditor.getValue();
  if (!trigger) {
    alert("Pick a trigger (event or time) - an automation with no trigger would never fire");
    return;
  }
  const conditions = automationConditionsEditor.getValue();
  const action = document.getElementById("automationAction").__getAutomationAction();
  if (!action) {
    alert("Add a macro first, or switch the action to Call one action");
    return;
  }
  const result = await saveAutomation({ id: editingAutomationId || undefined, name, trigger, conditions: conditions.length ? conditions : undefined, action });
  if (result.error) {
    alert(result.error);
    return;
  }
  resetAutomationForm(null);
  renderAutomationsTab();
});
document.getElementById("settings-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const latitude = document.getElementById("settingsLat").value;
  const longitude = document.getElementById("settingsLon").value;
  const result = await saveSettings({ latitude, longitude });
  if (result.error) alert(result.error);
});

// ---------------------------------------------------------------------
// Layout: drag-drop custom dashboard builder, ported from QTI's own
// live-custom.js/app.js feature (QTI is this project's own prior work,
// not RTI's - reusing an already-proven design, not approximating one).
// A page is {id, name, background, widgets:[{id,type,x,y,w,h,z,locked,...}]}
// on a 12-column grid - x/y/w/h are grid CELL indices, not pixels, so the
// same coordinates place a widget identically here and in layout.html's
// live renderer regardless of either canvas's actual row-pixel height
// (see server.js's sanitizeWidget comment for why Oak's widget types
// differ from QTI's: a single "slot" type with a {cat,slotId} pointer
// covers every Dashboard category at once here, since Oak's Dashboard is
// already unified around one generic slot shape per category - QTI needed
// one widget type per its own separate lights/media/doors/keypads/
// security/imageButtons arrays).
//
// Deliberately NOT ported from QTI's version (real feature cuts, not
// oversights): per-widget custom on/off images, the multi-select bulk
// toolbar, and "copy widget to another page" - all genuine QTI features,
// but each is meaningfully more code for a secondary polish gain; skipped
// to keep this port's surface area proportionate. Undo, multi-page,
// pointer-based drag/resize (not native HTML5 DnD - unreliable on touch,
// see QTI's own comment on why it avoided that API), and the broken-
// binding placeholder ARE ported, since those are the parts that make the
// feature actually usable/safe day-to-day rather than a demo.
// ---------------------------------------------------------------------
const LAYOUT_ROW_PITCH = 60; // px - must match style.css's .layout-canvas grid-auto-rows
let layoutPages = [];
let layoutCurrentPageId = null;
let layoutSelectedWidgetId = null;
let layoutUndoSnapshot = null; // single-level JSON snapshot, same "oops" recovery model as QTI's own - not a full history stack
let layoutCamerasCache = [];
let layoutMacrosCache = [];
let layoutPreviewOn = false;

function currentLayoutPage() {
  return layoutPages.find((p) => p.id === layoutCurrentPageId);
}
function persistLayoutPages() {
  bindingsCache.pages = layoutPages;
  return persistBindings();
}
function pushLayoutUndo() {
  layoutUndoSnapshot = JSON.stringify(layoutPages);
  document.getElementById("layoutUndoBtn").disabled = false;
}
async function undoLayoutChange() {
  if (!layoutUndoSnapshot) return;
  layoutPages = JSON.parse(layoutUndoSnapshot);
  layoutUndoSnapshot = null;
  document.getElementById("layoutUndoBtn").disabled = true;
  if (!currentLayoutPage()) layoutCurrentPageId = layoutPages[0] && layoutPages[0].id;
  layoutSelectedWidgetId = null;
  await persistLayoutPages();
  renderLayoutPageSelect();
  renderLayoutCanvas();
  renderLayoutWidgetEditor(null);
}

// Shared pointer-drag helper (mouse AND touch identically) - explicitly
// not the native HTML5 Drag and Drop API, which QTI's own port comment
// documents as unreliable on iOS Safari, exactly the device an installer
// would plausibly want to design a layout from on-site. A 6px movement
// threshold distinguishes a genuine drag from a tap-to-select.
function startPointerDrag(startEv, { threshold = 6, onDragStart, onDragMove, onDrop, onTap } = {}) {
  const downX = startEv.clientX;
  const downY = startEv.clientY;
  let dragging = false;
  let ghost = null;
  function move(ev) {
    if (!dragging) {
      if (Math.hypot(ev.clientX - downX, ev.clientY - downY) < threshold) return;
      dragging = true;
      if (onDragStart) ghost = onDragStart(ev);
    }
    if (ghost) {
      ghost.style.left = `${ev.clientX}px`;
      ghost.style.top = `${ev.clientY}px`;
    }
    if (onDragMove) onDragMove(ev);
  }
  function up(ev) {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    if (ghost) ghost.remove();
    if (dragging) {
      if (onDrop) onDrop(ev);
    } else if (onTap) {
      onTap(ev);
    }
  }
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
}
function layoutGridCellFromPoint(clientX, clientY) {
  const canvas = document.getElementById("layoutCanvas");
  const rect = canvas.getBoundingClientRect();
  const colWidth = rect.width / 12;
  const x = Math.max(0, Math.min(11, Math.floor((clientX - rect.left) / colWidth)));
  const y = Math.max(0, Math.floor((clientY - rect.top) / LAYOUT_ROW_PITCH));
  return { x, y };
}
function pointerOverCanvas(ev) {
  const rect = document.getElementById("layoutCanvas").getBoundingClientRect();
  return ev.clientX >= rect.left && ev.clientX <= rect.right && ev.clientY >= rect.top && ev.clientY <= rect.bottom;
}
function makeDragGhost(label) {
  const ghost = document.createElement("div");
  ghost.className = "layout-drag-ghost";
  ghost.textContent = label;
  document.body.appendChild(ghost);
  return ghost;
}

function layoutWidgetIcon(w) {
  if (w.type === "slot") return CATEGORY_ICON[w.cat] || "⚙️";
  return { camera: "📷", macro: "▶️", pageLink: "🔗", appUrl: "🌐", label: "📝", varDisplay: "📊" }[w.type] || "❔";
}
function layoutWidgetLabel(w) {
  if (w.type === "slot") {
    const slot = (bindingsCache[w.cat] || []).find((s) => s.id === w.slotId);
    return slot ? slot.name : "(missing binding)";
  }
  if (w.type === "camera") return (layoutCamerasCache.find((c) => c.id === w.cameraId) || {}).name || "(missing camera)";
  if (w.type === "macro") return (layoutMacrosCache.find((m) => m.id === w.macroId) || {}).name || "(missing macro)";
  if (w.type === "pageLink" || w.type === "appUrl") return w.label || "Link";
  if (w.type === "label") return w.text || "(empty label)";
  if (w.type === "varDisplay") return w.label || "Value";
  return w.type;
}

// ---------------------------------------------------------------------
// Palette: one chip per existing Dashboard slot (grouped by category, so
// it's always in sync with the Dashboard tab - nothing here is a
// separate list to maintain), plus cameras, macros, and 4 fixed special
// chips. Dragging a chip onto the canvas places a widget there.
// ---------------------------------------------------------------------
function renderLayoutPalette() {
  const root = document.getElementById("layoutPalette");
  root.innerHTML = "";
  function addGroupLabel(text) {
    const el = document.createElement("div");
    el.className = "layout-palette-group-label";
    el.textContent = text;
    root.appendChild(el);
  }
  function addChip(label, icon, buildWidget) {
    const chip = document.createElement("div");
    chip.className = "layout-palette-chip";
    chip.textContent = `${icon} ${label}`;
    chip.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      startPointerDrag(ev, {
        onDragStart: () => makeDragGhost(label),
        onDrop: (dropEv) => {
          if (!pointerOverCanvas(dropEv)) return;
          const { x, y } = layoutGridCellFromPoint(dropEv.clientX, dropEv.clientY);
          const partial = buildWidget(x, y);
          if (partial) addLayoutWidget(partial);
        },
      });
    });
    root.appendChild(chip);
  }
  CATEGORY_ORDER.forEach((cat) => {
    const slots = bindingsCache[cat] || [];
    if (!slots.length) return;
    addGroupLabel(CATEGORY_LABEL[cat]);
    slots.forEach((slot) => addChip(slot.name, CATEGORY_ICON[cat], (x, y) => ({ type: "slot", cat, slotId: slot.id, x, y, w: 2, h: 2 })));
  });
  if (layoutCamerasCache.length) {
    addGroupLabel("Cameras");
    layoutCamerasCache.forEach((c) => addChip(c.name, "📷", (x, y) => ({ type: "camera", cameraId: c.id, x, y, w: 3, h: 3 })));
  }
  if (layoutMacrosCache.length) {
    addGroupLabel("Macros");
    layoutMacrosCache.forEach((m) => addChip(m.name, "▶️", (x, y) => ({ type: "macro", macroId: m.id, x, y, w: 2, h: 1 })));
  }
  addGroupLabel("Other");
  addChip("Page Link", "🔗", (x, y) => {
    const target = layoutPages.find((p) => p.id !== layoutCurrentPageId);
    if (!target) {
      alert("Add another page first - a Page Link needs a page to point to.");
      return null;
    }
    return { type: "pageLink", label: target.name, targetPageId: target.id, x, y, w: 2, h: 1 };
  });
  addChip("App URL", "🌐", (x, y) => ({ type: "appUrl", label: "Link", url: "https://", x, y, w: 2, h: 1 }));
  addChip("Label", "📝", (x, y) => ({ type: "label", text: "Label", x, y, w: 2, h: 1 }));
  addChip("Variable Display", "📊", (x, y) =>
    instanceIds.length ? { type: "varDisplay", label: "Value", instanceId: instanceIds[0], stateId: "", x, y, w: 2, h: 1 } : (alert("Add a driver instance first."), null)
  );
}
function addLayoutWidget(partial) {
  pushLayoutUndo();
  const widget = { id: Math.random().toString(16).slice(2, 10), locked: false, ...partial };
  currentLayoutPage().widgets.push(widget);
  persistLayoutPages();
  renderLayoutCanvas();
  selectLayoutWidget(widget.id);
}

// ---------------------------------------------------------------------
// Canvas: renders the current page's widgets as schematic (icon + name)
// boxes, positioned via inline grid-column/row from their x/y/w/h - not
// live-interactive (dragging would conflict with a real toggle click
// anyway); use Preview for the actual end-user rendering.
// ---------------------------------------------------------------------
function renderLayoutCanvas() {
  const canvas = document.getElementById("layoutCanvas");
  canvas.innerHTML = "";
  const page = currentLayoutPage();
  if (!page) return;
  canvas.style.backgroundImage = page.background && page.background.url ? `url(${page.background.url})` : "";
  page.widgets.forEach((w) => canvas.appendChild(buildLayoutWidgetBox(w)));
}
function buildLayoutWidgetBox(w) {
  const box = document.createElement("div");
  box.className = "layout-widget" + (w.id === layoutSelectedWidgetId ? " selected" : "") + (w.locked ? " locked" : "");
  box.style.gridColumn = `${w.x + 1} / span ${w.w}`;
  box.style.gridRow = `${w.y + 1} / span ${w.h}`;
  if (w.z) box.style.zIndex = w.z;
  box.innerHTML = `<div class="lw-type">${w.type}${w.locked ? " 🔒" : ""}</div><div class="lw-name">${layoutWidgetIcon(w)} ${layoutWidgetLabel(w)}</div>`;
  if (!w.locked) {
    const handle = document.createElement("div");
    handle.className = "resize-handle";
    handle.textContent = "↘";
    handle.addEventListener("pointerdown", (ev) => startLayoutResize(ev, w, box));
    box.appendChild(handle);
    box.addEventListener("pointerdown", (ev) => {
      if (ev.target === handle) return;
      startLayoutWidgetMove(ev, w);
    });
  } else {
    box.addEventListener("click", () => selectLayoutWidget(w.id));
  }
  return box;
}
function startLayoutWidgetMove(startEv, widget) {
  startPointerDrag(startEv, {
    onDragStart: () => makeDragGhost(layoutWidgetLabel(widget)),
    onDrop: (ev) => {
      if (!pointerOverCanvas(ev)) return;
      const { x, y } = layoutGridCellFromPoint(ev.clientX, ev.clientY);
      pushLayoutUndo();
      widget.x = Math.min(12 - widget.w, x);
      widget.y = y;
      persistLayoutPages();
      renderLayoutCanvas();
    },
    onTap: () => selectLayoutWidget(widget.id),
  });
}
function startLayoutResize(startEv, widget, box) {
  startEv.stopPropagation();
  startEv.preventDefault();
  const startX = startEv.clientX;
  const startY = startEv.clientY;
  const startW = widget.w;
  const startH = widget.h;
  const colWidth = document.getElementById("layoutCanvas").getBoundingClientRect().width / 12;
  let newW = startW;
  let newH = startH;
  function move(ev) {
    const dCols = Math.round((ev.clientX - startX) / colWidth);
    const dRows = Math.round((ev.clientY - startY) / LAYOUT_ROW_PITCH);
    newW = Math.max(1, Math.min(12 - widget.x, startW + dCols));
    newH = Math.max(1, startH + dRows);
    box.style.gridColumn = `${widget.x + 1} / span ${newW}`;
    box.style.gridRow = `${widget.y + 1} / span ${newH}`;
  }
  function up() {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    if (newW !== startW || newH !== startH) {
      pushLayoutUndo();
      widget.w = newW;
      widget.h = newH;
      persistLayoutPages();
      renderLayoutCanvas();
    }
  }
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
}
function selectLayoutWidget(id) {
  layoutSelectedWidgetId = id;
  renderLayoutCanvas();
  const widget = currentLayoutPage().widgets.find((w) => w.id === id);
  renderLayoutWidgetEditor(widget);
}

// ---------------------------------------------------------------------
// Widget editor: placement-only options (this is explicitly NOT where
// you rename a light or rebind its function - that stays on the
// Dashboard/Macro tab, same boundary QTI's own editor draws) plus each
// special type's own inline fields.
// ---------------------------------------------------------------------
function renderLayoutWidgetEditor(widget) {
  const box = document.getElementById("layoutWidgetEditor");
  if (!widget) {
    box.classList.add("layout-hidden");
    box.innerHTML = "";
    return;
  }
  box.classList.remove("layout-hidden");
  let fieldsHtml = "";
  if (widget.type === "pageLink") {
    const otherPages = layoutPages.filter((p) => p.id !== layoutCurrentPageId);
    fieldsHtml = `<label><span class="lbl">Label</span><input id="lwLabel" type="text" value="${widget.label || ""}" /></label>
      <label><span class="lbl">Target page</span><select id="lwTarget">${otherPages.map((p) => `<option value="${p.id}"${p.id === widget.targetPageId ? " selected" : ""}>${p.name}</option>`).join("")}</select></label>`;
  } else if (widget.type === "appUrl") {
    fieldsHtml = `<label><span class="lbl">Label</span><input id="lwLabel" type="text" value="${widget.label || ""}" /></label>
      <label><span class="lbl">URL</span><input id="lwUrl" type="text" value="${widget.url || ""}" /></label>
      <label style="display:flex; align-items:center; gap:6px; flex-direction:row;"><input id="lwNewTab" type="checkbox" ${widget.openInNewTab ? "checked" : ""} /> <span class="lbl" style="margin:0;">Open in new tab</span></label>`;
  } else if (widget.type === "label") {
    fieldsHtml = `<label><span class="lbl">Text</span><input id="lwText" type="text" value="${widget.text || ""}" /></label>`;
  } else if (widget.type === "varDisplay") {
    fieldsHtml = `<label><span class="lbl">Label</span><input id="lwLabel" type="text" value="${widget.label || ""}" /></label>
      <label><span class="lbl">Instance</span><select id="lwVarInst">${instanceIds.map((id) => `<option value="${id}"${id === widget.instanceId ? " selected" : ""}>${instanceLabel(id)} (${id})</option>`).join("")}</select></label>
      <label><span class="lbl">State</span><select id="lwVarState"></select></label>
      <label><span class="lbl">Suffix (optional)</span><input id="lwVarSuffix" type="text" value="${widget.stateSuffix || ""}" /></label>`;
  } else if (widget.type === "slot") {
    const slot = (bindingsCache[widget.cat] || []).find((s) => s.id === widget.slotId);
    fieldsHtml = `<p class="empty-hint">Edit its function/state on the Dashboard tab - only placement options live here.</p>`;
    if (slot && slot.levelFn) {
      fieldsHtml += `<label style="display:flex; align-items:center; gap:6px; flex-direction:row;"><input id="lwShowLevel" type="checkbox" ${widget.showLevel !== false ? "checked" : ""} /> <span class="lbl" style="margin:0;">Show level control</span></label>`;
    }
  } else if (widget.type === "camera" && !layoutCamerasCache.some((c) => c.id === widget.cameraId)) {
    fieldsHtml = `<p class="empty-hint">⚠ This camera no longer exists.</p>`;
  } else if (widget.type === "macro" && !layoutMacrosCache.some((m) => m.id === widget.macroId)) {
    fieldsHtml = `<p class="empty-hint">⚠ This macro no longer exists.</p>`;
  }
  box.innerHTML = `
    <h2 style="font-size:.9rem;">${layoutWidgetIcon(widget)} ${layoutWidgetLabel(widget)}</h2>
    ${fieldsHtml}
    <label style="display:flex; align-items:center; gap:6px; flex-direction:row; margin-top:8px;"><input id="lwLocked" type="checkbox" ${widget.locked ? "checked" : ""} /> <span class="lbl" style="margin:0;">Locked</span></label>
    <div class="row" style="margin-top:10px;">
      <button class="btn small" id="lwFrontBtn" type="button">Bring to front</button>
      <button class="btn small" id="lwBackBtn" type="button">Send to back</button>
    </div>
    <div class="row" style="margin-top:8px;">
      <button class="btn small danger" id="lwRemoveBtn" type="button">Remove from page</button>
    </div>`;

  if (widget.type === "varDisplay") {
    const stateSel = document.getElementById("lwVarState");
    const instSel = document.getElementById("lwVarInst");
    function renderStates() {
      const manifest = manifests.get(instSel.value);
      stateSel.innerHTML = (manifest ? manifest.states : []).map((s) => `<option value="${s.id}"${s.id === widget.stateId ? " selected" : ""}>${s.id}</option>`).join("");
    }
    instSel.addEventListener("change", renderStates);
    renderStates();
  }

  function commitField(fn) {
    pushLayoutUndo();
    fn();
    persistLayoutPages();
    renderLayoutCanvas();
    renderLayoutWidgetEditor(widget);
  }
  const bind = (id, evt, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(evt, () => commitField(fn));
  };
  bind("lwLabel", "change", () => (widget.label = document.getElementById("lwLabel").value));
  bind("lwTarget", "change", () => (widget.targetPageId = document.getElementById("lwTarget").value));
  bind("lwUrl", "change", () => (widget.url = document.getElementById("lwUrl").value));
  bind("lwNewTab", "change", () => (widget.openInNewTab = document.getElementById("lwNewTab").checked));
  bind("lwText", "change", () => (widget.text = document.getElementById("lwText").value));
  bind("lwVarInst", "change", () => (widget.instanceId = document.getElementById("lwVarInst").value));
  bind("lwVarState", "change", () => (widget.stateId = document.getElementById("lwVarState").value));
  bind("lwVarSuffix", "change", () => (widget.stateSuffix = document.getElementById("lwVarSuffix").value || undefined));
  bind("lwShowLevel", "change", () => (widget.showLevel = document.getElementById("lwShowLevel").checked));
  bind("lwLocked", "change", () => (widget.locked = document.getElementById("lwLocked").checked));
  document.getElementById("lwFrontBtn").addEventListener("click", () =>
    commitField(() => {
      const maxZ = Math.max(0, ...currentLayoutPage().widgets.map((w) => w.z || 0));
      widget.z = maxZ + 1;
    })
  );
  document.getElementById("lwBackBtn").addEventListener("click", () =>
    commitField(() => {
      const minZ = Math.min(0, ...currentLayoutPage().widgets.map((w) => w.z || 0));
      widget.z = minZ - 1;
    })
  );
  document.getElementById("lwRemoveBtn").addEventListener("click", async () => {
    if (!confirm(`Remove "${layoutWidgetLabel(widget)}" from this page?`)) return;
    pushLayoutUndo();
    const page = currentLayoutPage();
    page.widgets = page.widgets.filter((w) => w.id !== widget.id);
    layoutSelectedWidgetId = null;
    await persistLayoutPages();
    renderLayoutCanvas();
    renderLayoutWidgetEditor(null);
  });
}

// ---------------------------------------------------------------------
// Page toolbar + tab bootstrap
// ---------------------------------------------------------------------
function renderLayoutPageSelect() {
  const sel = document.getElementById("layoutPageSelect");
  sel.innerHTML = layoutPages.map((p) => `<option value="${p.id}"${p.id === layoutCurrentPageId ? " selected" : ""}>${p.name}</option>`).join("");
}
async function ensureLayoutPage() {
  if (!bindingsCache.pages.length) {
    bindingsCache.pages.push({ id: Math.random().toString(16).slice(2, 10), name: "Main", background: null, widgets: [] });
    await persistBindings();
  }
  layoutPages = bindingsCache.pages;
  if (!layoutCurrentPageId || !currentLayoutPage()) layoutCurrentPageId = layoutPages[0].id;
}
async function openLayoutTab() {
  await ensureBindingsCache();
  const [cams, macroList] = await Promise.all([listCameras(), listMacros()]);
  layoutCamerasCache = cams;
  layoutMacrosCache = macroList;
  await ensureLayoutPage();
  layoutSelectedWidgetId = null;
  layoutUndoSnapshot = null;
  document.getElementById("layoutUndoBtn").disabled = true;
  renderLayoutPageSelect();
  renderLayoutPalette();
  renderLayoutCanvas();
  renderLayoutWidgetEditor(null);
  if (layoutPreviewOn) reloadLayoutPreview();
}
function moveLayoutPage(delta) {
  const idx = layoutPages.findIndex((p) => p.id === layoutCurrentPageId);
  const newIdx = idx + delta;
  if (newIdx < 0 || newIdx >= layoutPages.length) return;
  pushLayoutUndo();
  [layoutPages[idx], layoutPages[newIdx]] = [layoutPages[newIdx], layoutPages[idx]];
  persistLayoutPages();
  renderLayoutPageSelect();
}
document.getElementById("layoutPageSelect").addEventListener("change", (ev) => {
  layoutCurrentPageId = ev.target.value;
  layoutSelectedWidgetId = null;
  renderLayoutCanvas();
  renderLayoutWidgetEditor(null);
});
document.getElementById("layoutPageUpBtn").addEventListener("click", () => moveLayoutPage(-1));
document.getElementById("layoutPageDownBtn").addEventListener("click", () => moveLayoutPage(1));
document.getElementById("layoutAddPageBtn").addEventListener("click", async () => {
  const name = prompt("Page name:", `Page ${layoutPages.length + 1}`);
  if (!name) return;
  pushLayoutUndo();
  const page = { id: Math.random().toString(16).slice(2, 10), name: name.slice(0, 60), background: null, widgets: [] };
  layoutPages.push(page);
  layoutCurrentPageId = page.id;
  await persistLayoutPages();
  renderLayoutPageSelect();
  renderLayoutCanvas();
  renderLayoutWidgetEditor(null);
});
document.getElementById("layoutRenamePageBtn").addEventListener("click", async () => {
  const page = currentLayoutPage();
  if (!page) return;
  const name = prompt("Page name:", page.name);
  if (!name) return;
  pushLayoutUndo();
  page.name = name.slice(0, 60);
  await persistLayoutPages();
  renderLayoutPageSelect();
});
document.getElementById("layoutDeletePageBtn").addEventListener("click", async () => {
  const page = currentLayoutPage();
  if (!page) return;
  if (layoutPages.length === 1) {
    alert("Can't delete the only page.");
    return;
  }
  if (!confirm(`Delete page "${page.name}"?`)) return;
  pushLayoutUndo();
  layoutPages = layoutPages.filter((p) => p.id !== page.id);
  layoutCurrentPageId = layoutPages[0].id;
  await persistLayoutPages();
  renderLayoutPageSelect();
  renderLayoutCanvas();
  renderLayoutWidgetEditor(null);
});
document.getElementById("layoutUndoBtn").addEventListener("click", undoLayoutChange);
document.getElementById("layoutBgUploadBtn").addEventListener("click", async () => {
  const page = currentLayoutPage();
  const input = document.getElementById("layoutBgInput");
  const file = input.files[0];
  if (!file) {
    alert("Pick an image file first");
    return;
  }
  const buf = await file.arrayBuffer();
  const dataBase64 = btoa(new Uint8Array(buf).reduce((s, b) => s + String.fromCharCode(b), ""));
  const result = await uploadImage(file.name, dataBase64);
  if (result.error) {
    alert(result.error);
    return;
  }
  pushLayoutUndo();
  page.background = { url: result.url };
  await persistLayoutPages();
  renderLayoutCanvas();
});
document.getElementById("layoutBgClearBtn").addEventListener("click", async () => {
  const page = currentLayoutPage();
  if (!page || !page.background) return;
  pushLayoutUndo();
  page.background = null;
  await persistLayoutPages();
  renderLayoutCanvas();
});
function reloadLayoutPreview() {
  document.getElementById("layoutPreviewFrame").src = `layout.html?preview=${Date.now()}&page=${encodeURIComponent(layoutCurrentPageId || "")}`;
}
document.getElementById("layoutPreviewBtn").addEventListener("click", (ev) => {
  layoutPreviewOn = !layoutPreviewOn;
  ev.target.textContent = `Preview: ${layoutPreviewOn ? "On" : "Off"}`;
  document.getElementById("layoutPreviewFrame").classList.toggle("layout-hidden", !layoutPreviewOn);
  if (layoutPreviewOn) reloadLayoutPreview();
  else document.getElementById("layoutPreviewFrame").src = "";
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

// --- 3D: mesh-to-device binding editor, ported from QTI's own
// create3DViewer + app.js's openMeshBindPicker (QTI is this project's own
// prior work, not RTI's - reusing an already-proven design). A scene is a
// named GLB model + a meshBindings map (mesh name -> {cat, id, animType,
// axis, dir}), persisted as bindings.glbs alongside the Dashboard's own
// category slot arrays (see server.js's sanitizeGlbScene) - multiple
// scenes (e.g. one per floor) are supported, matching QTI's own scene
// picker. A mesh binding is a POINTER into bindingsCache[cat] by slot id,
// not a copy - see roles.js's bindingSlot comment - so the 3D view always
// reflects the Dashboard tab's current device wiring.
let glb3dEditMode = false;
let glb3dCurrentSceneId = null;

async function ensureBindingsCache() {
  if (!bindingsCache) bindingsCache = await getBindings();
  return bindingsCache;
}
function currentGlb3DScene() {
  return (bindingsCache && bindingsCache.glbs || []).find((s) => s.id === glb3dCurrentSceneId);
}
function resolveMeshOnLevel(mb) {
  return resolveMeshOnLevelShared(bindingsCache, statesByInstance, mb);
}
function dispatchMeshDeviceClick(mb) {
  const slot = bindingSlot(bindingsCache, mb);
  if (!slot) return;
  const { on } = resolveMeshOnLevel(mb);
  const fn = on ? slot.offFn : slot.onFn;
  if (!fn) return;
  callFnShared(fn, slot, { callAction, runMacro }).then(() => viewer3d.updateVisuals());
}

const viewer3d = create3DViewer({
  editable: () => glb3dEditMode,
  onEditClick: (meshName, x, y) => openMeshBindPicker(meshName, x, y),
  onDeviceClick: dispatchMeshDeviceClick,
  getMeshBindings: () => (currentGlb3DScene() || {}).meshBindings || {},
  resolveOnLevel: resolveMeshOnLevel,
  onLoadProgress: createGlbProgressHandler("glb3dProgressTrack", "glb3dProgressBar"),
});
let viewer3dInited = false;

function renderGlb3DHint() {
  const scene = currentGlb3DScene();
  const hintEl = document.getElementById("glb3dHint");
  if (!scene) {
    hintEl.textContent = `No scenes yet - "+ Add Scene" to create one.`;
    return;
  }
  const bound = Object.keys(scene.meshBindings || {}).length;
  hintEl.textContent = glb3dEditMode
    ? `Edit mode: click a mesh in the model to bind it to a device and animation (${bound} bound).`
    : `Click a bound mesh to toggle its device (${bound} bound). Turn on Edit Bindings to rebind meshes.`;
}
function renderGlb3DSceneSelect() {
  const sel = document.getElementById("glb3dSceneSelect");
  const scenes = (bindingsCache && bindingsCache.glbs) || [];
  sel.innerHTML = scenes.map((s) => `<option value="${s.id}"${s.id === glb3dCurrentSceneId ? " selected" : ""}>${s.name}</option>`).join("");
}
async function loadGlb3DScene(sceneId) {
  glb3dCurrentSceneId = sceneId;
  renderGlb3DSceneSelect();
  const scene = currentGlb3DScene();
  const hintEl = document.getElementById("glbHint");
  if (!scene || !scene.url) {
    hintEl.style.display = "flex";
    hintEl.textContent = scene ? "Upload a .glb for this scene to get started" : "Add a scene and upload a .glb to get started";
  } else {
    hintEl.style.display = "none";
    viewer3d.loadGLB(scene.url);
  }
  renderGlb3DHint();
}

// Retried with backoff on init failure - a transient CDN hiccup fetching
// three.js shouldn't leave the tab permanently stuck with no explanation,
// the exact failure mode QTI's own initViewer3DWithRetry comment
// documents hitting.
async function initViewer3DWithRetry(attempt) {
  attempt = attempt || 0;
  try {
    await viewer3d.init();
    viewer3dInited = true;
  } catch (e) {
    console.error(`3D viewer init failed (attempt ${attempt + 1}):`, e);
    if (attempt < 3) setTimeout(() => initViewer3DWithRetry(attempt + 1), 1500 * (attempt + 1));
  }
}
async function open3DTab() {
  await ensureBindingsCache();
  if (!bindingsCache.glbs.length) {
    bindingsCache.glbs.push({ id: Math.random().toString(16).slice(2, 10), name: "Main Scene", url: null, meshBindings: {} });
    persistBindings();
  }
  if (!glb3dCurrentSceneId || !currentGlb3DScene()) glb3dCurrentSceneId = bindingsCache.glbs[0].id;
  if (!viewer3dInited) await initViewer3DWithRetry();
  await loadGlb3DScene(glb3dCurrentSceneId);
}

document.getElementById("glb3dSceneSelect").addEventListener("change", (ev) => loadGlb3DScene(ev.target.value));
document.getElementById("glb3dAddSceneBtn").addEventListener("click", async () => {
  const name = prompt("Scene name:", `Scene ${bindingsCache.glbs.length + 1}`);
  if (!name) return;
  const scene = { id: Math.random().toString(16).slice(2, 10), name: name.slice(0, 60), url: null, meshBindings: {} };
  bindingsCache.glbs.push(scene);
  await persistBindings();
  await loadGlb3DScene(scene.id);
});
document.getElementById("glb3dRenameSceneBtn").addEventListener("click", async () => {
  const scene = currentGlb3DScene();
  if (!scene) return;
  const name = prompt("Scene name:", scene.name);
  if (!name) return;
  scene.name = name.slice(0, 60);
  await persistBindings();
  renderGlb3DSceneSelect();
});
document.getElementById("glb3dDeleteSceneBtn").addEventListener("click", async () => {
  const scene = currentGlb3DScene();
  if (!scene) return;
  if (!confirm(`Delete scene "${scene.name}"? This only removes its bindings, not the uploaded .glb file.`)) return;
  bindingsCache.glbs = bindingsCache.glbs.filter((s) => s.id !== scene.id);
  await persistBindings();
  if (!bindingsCache.glbs.length) {
    bindingsCache.glbs.push({ id: Math.random().toString(16).slice(2, 10), name: "Main Scene", url: null, meshBindings: {} });
    await persistBindings();
  }
  await loadGlb3DScene(bindingsCache.glbs[0].id);
});
document.getElementById("glb3dEditToggleBtn").addEventListener("click", (ev) => {
  glb3dEditMode = !glb3dEditMode;
  ev.target.textContent = `Edit Bindings: ${glb3dEditMode ? "On" : "Off"}`;
  ev.target.classList.toggle("primary", glb3dEditMode);
  renderGlb3DHint();
});
document.getElementById("glbUploadBtn").addEventListener("click", async () => {
  const scene = currentGlb3DScene();
  if (!scene) {
    alert("Add a scene first");
    return;
  }
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
  scene.url = result.url;
  await persistBindings();
  document.getElementById("glbHint").style.display = "none";
  if (!viewer3dInited) await initViewer3DWithRetry();
  viewer3d.loadGLB(scene.url);
  renderGlb3DHint();
});

// Floating popup positioned at the click point, matching QTI's own
// openMeshBindPicker exactly (a small anchored popup, not a modal) - the
// device dropdown is grouped by category the same way the Dashboard tab
// itself is, sourced straight from bindingsCache so a mesh can only ever
// be bound to a slot that actually exists.
let meshBindPopupEl = null;
function closeMeshBindPopup() {
  if (meshBindPopupEl) meshBindPopupEl.remove();
  meshBindPopupEl = null;
}
function openMeshBindPicker(meshName, clientX, clientY) {
  closeMeshBindPopup();
  const scene = currentGlb3DScene();
  if (!scene) return;
  const existing = scene.meshBindings[meshName];

  const popup = document.createElement("div");
  popup.className = "card";
  popup.style.cssText = `position:fixed; left:${Math.min(clientX, window.innerWidth - 300)}px; top:${Math.min(clientY, window.innerHeight - 260)}px; width:280px; z-index:500; box-shadow:0 8px 30px rgba(0,0,0,0.35);`;

  const deviceOptions = CATEGORY_ORDER.map((cat) => {
    const slots = (bindingsCache[cat] || []);
    if (!slots.length) return "";
    const opts = slots
      .map((s) => `<option value="${cat}:${s.id}"${existing && existing.cat === cat && existing.id === s.id ? " selected" : ""}>${s.name}</option>`)
      .join("");
    return `<optgroup label="${CATEGORY_LABEL[cat]}">${opts}</optgroup>`;
  }).join("");

  popup.innerHTML = `
    <h2 style="font-size:.9rem;">${meshName}</h2>
    <label><span class="lbl">Device</span>
      <select id="meshBindDevice"><option value="">— unbound —</option>${deviceOptions}</select>
    </label>
    <label><span class="lbl">Animation</span>
      <select id="meshBindAnim">${ANIM_TYPES.map((a) => `<option value="${a.value}"${existing && existing.animType === a.value ? " selected" : ""}>${a.label}</option>`).join("")}</select>
    </label>
    <div class="row" id="meshBindAxisRow" style="display:none;">
      <label><span class="lbl">Axis</span>
        <select id="meshBindAxis">${["x", "y", "z"].map((a) => `<option value="${a}"${existing && existing.axis === a ? " selected" : ""}>${a}</option>`).join("")}</select>
      </label>
      <label><span class="lbl">Direction</span>
        <select id="meshBindDir">
          <option value="1"${!existing || existing.dir === 1 ? " selected" : ""}>+</option>
          <option value="-1"${existing && existing.dir === -1 ? " selected" : ""}>-</option>
        </select>
      </label>
    </div>
    <div class="row" style="margin-top:10px;">
      <button class="btn small primary" id="meshBindSaveBtn" type="button">Save</button>
      <button class="btn small danger" id="meshBindUnbindBtn" type="button">Unbind</button>
      <button class="btn small" id="meshBindCancelBtn" type="button">Cancel</button>
    </div>`;
  document.body.appendChild(popup);
  meshBindPopupEl = popup;

  const animSel = popup.querySelector("#meshBindAnim");
  const axisRow = popup.querySelector("#meshBindAxisRow");
  function syncAxisRow() {
    axisRow.style.display = AXIS_ANIM_TYPES.has(animSel.value) ? "flex" : "none";
  }
  animSel.addEventListener("change", syncAxisRow);
  syncAxisRow();

  popup.querySelector("#meshBindSaveBtn").addEventListener("click", async () => {
    const deviceVal = popup.querySelector("#meshBindDevice").value;
    if (!deviceVal) {
      delete scene.meshBindings[meshName];
    } else {
      const [cat, id] = deviceVal.split(/:(.*)/s);
      const mb = { cat, id, animType: animSel.value };
      if (AXIS_ANIM_TYPES.has(mb.animType)) {
        mb.axis = popup.querySelector("#meshBindAxis").value;
        mb.dir = Number(popup.querySelector("#meshBindDir").value);
      }
      scene.meshBindings[meshName] = mb;
    }
    await persistBindings();
    viewer3d.updateVisuals();
    renderGlb3DHint();
    closeMeshBindPopup();
  });
  popup.querySelector("#meshBindUnbindBtn").addEventListener("click", async () => {
    delete scene.meshBindings[meshName];
    await persistBindings();
    viewer3d.updateVisuals();
    renderGlb3DHint();
    closeMeshBindPopup();
  });
  popup.querySelector("#meshBindCancelBtn").addEventListener("click", closeMeshBindPopup);
}

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
// Grouped by category (same CATEGORY_ORDER/CATEGORY_LABEL every other
// grouped list in this file already uses - the Dashboard tab's category
// cards, the Layout palette) rather than one flat list - with 19+ built-in
// drivers now, a flat list stopped being easy to scan. A driver with
// multiple declared categories (e.g. zone-hub's light+climate) is only
// listed once, under its first one, so it doesn't visually appear twice.
async function renderUploadedDriversList() {
  const listEl = document.getElementById("uploadedDriversList");
  const drivers = await listDrivers();
  if (!drivers.length) {
    listEl.innerHTML = `<p class="empty-hint">No drivers found.</p>`;
    return;
  }
  listEl.innerHTML = "";
  const byCategory = new Map(CATEGORY_ORDER.map((c) => [c, []]));
  drivers.forEach((d) => {
    const cat = effectiveCategories(d)[0];
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(d);
  });
  for (const cat of [...byCategory.keys()]) {
    const group = byCategory.get(cat);
    if (!group.length) continue;
    const storageKey = `oak_driverlist_collapsed_${cat}`;
    let collapsed = localStorage.getItem(storageKey) === "1";

    const groupLabel = document.createElement("div");
    groupLabel.className = "layout-palette-group-label";
    groupLabel.style.cssText = "margin-top:10px; cursor:pointer; display:flex; align-items:center; gap:6px;";
    const chev = document.createElement("span");
    chev.className = "card-chev";
    // Same .tile-grid/.tile convention the Camera tab already uses (a
    // driver isn't a live-state row the way a running instance is, so a
    // compact icon tile fits better than a full-width instance-row once
    // there are this many drivers to scan).
    const rowsEl = document.createElement("div");
    rowsEl.className = "tile-grid tile-grid-3col";
    function applyCollapsed() {
      chev.textContent = collapsed ? "▸" : "▾";
      rowsEl.style.display = collapsed ? "none" : "";
    }
    groupLabel.append(chev, document.createTextNode(`${CATEGORY_ICON[cat] || "⚙️"} ${CATEGORY_LABEL[cat] || cat} (${group.length})`));
    groupLabel.addEventListener("click", () => {
      collapsed = !collapsed;
      localStorage.setItem(storageKey, collapsed ? "1" : "0");
      applyCollapsed();
    });
    applyCollapsed();
    listEl.append(groupLabel, rowsEl);
    group.forEach((d) => {
      const tile = document.createElement("div");
      tile.className = "tile";
      tile.style.cssText = "cursor:default; text-align:center;";
      tile.innerHTML = `
        <div style="font-size:32px;">${d.icon || CATEGORY_ICON[cat] || "⚙️"}</div>
        <div class="tname" style="margin-top:6px;">${d.displayName}</div>
        <div class="tstate">${d.id}</div>`;
      const delBtn = document.createElement("button");
      delBtn.className = "btn small danger";
      delBtn.textContent = "Delete";
      delBtn.style.cssText = "margin-top:10px; width:100%;";
      delBtn.addEventListener("click", async () => {
        if (!confirm(`Delete driver "${d.displayName}" permanently? The files are removed from disk.`)) return;
        const result = await deleteDriverPackage(d.id);
        if (result.error) {
          alert(result.error);
          return;
        }
        renderUploadedDriversList();
      });
      tile.appendChild(delBtn);
      rowsEl.appendChild(tile);
    });
  }
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
    const filtered = cat === "__all__" ? drivers : drivers.filter((d) => effectiveCategories(d).includes(cat));
    // Stable, predictable order within a category (alphabetical by display
    // name) rather than whatever order the drivers directory happens to
    // list them in - matches the same "category, then a sensible driver
    // order" the Uploaded Drivers tile grid already established.
    return [...filtered].sort((a, b) => a.displayName.localeCompare(b.displayName));
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
  categoryPicker.value = presentCats[0] || "__all__";
  categoryPicker.addEventListener("change", () => renderDriverOptionsFor(categoryPicker.value));

  const driverPicker = document.createElement("select");
  driverPicker.name = "driver";
  driverPicker.addEventListener("change", () => renderFieldsFor(driverPicker.value));

  fieldsRoot.before(categoryPicker, driverPicker);
  renderDriverOptionsFor(categoryPicker.value);

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
