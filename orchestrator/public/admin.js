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
let bindingsCache = null; // {light:[], switch:[], ...} - loaded when the Dashboard tab is opened
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
    row.innerHTML = `<div><div class="iname">${manifest.displayName}${
      running ? "" : ' <span class="istatus">stopped</span>'
    }</div><div class="ikey">${manifest.id} · ${id}</div></div>`;
    row.addEventListener("click", () => {
      instanceFilter.value = id;
      renderActivePanel();
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
    o.textContent = manifests.get(id).displayName + " (" + id + ")";
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
    tr.innerHTML = `<td>${manifests.get(id).displayName}</td><td>${key}</td><td>${valueHtml}</td>`;
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
      notice.textContent = `${manifests.get(id).displayName} is stopped - start it (Running instances, or the Config tab) to use its actions.`;
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
          <span class="tname">${isToggleAction ? manifest.displayName : a.label}</span>
          ${switchHtml}
        </div>
        ${isToggleAction ? "" : `<button class="btn small" type="submit">${a.label}</button>`}
        ${fieldInputs(a)}
        <div class="tstate">${manifest.displayName} · ${id}</div>`;
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
  const label = manifests.has(instanceId) ? manifests.get(instanceId).displayName : instanceId;
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

  function fieldInput(prefix, f, currentValue) {
    const value = currentValue !== undefined ? currentValue : f.default;
    return `<label><span class="lbl">${f.label}</span><input name="${prefix}.${f.key}" type="${
      f.type === "number" ? "number" : "text"
    }" value="${value !== undefined ? value : ""}" ${running ? "disabled" : ""} /></label>`;
  }

  const connFields = (driverManifest.connection.options[0].fields || [])
    .map((f) => fieldInput("connection", f, cfg.connection[f.key]))
    .join("");
  const settingFields = (driverManifest.settings || []).map((f) => fieldInput("settings", f, cfg.settings[f.key])).join("");

  configPanel.innerHTML = `
    <p class="sub">instance "${id}" · driver ${manifest.id} · ${running ? "running" : "stopped"}</p>
    <p class="sub">Dashboard presentation (name, category, which function is On/Off/Level) is configured on the <a href="#dashboard" onclick="location.hash='dashboard'">Dashboard</a> tab, not here - it's a binding, not part of this instance's connection.</p>
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

  document.getElementById("configToggleRunBtn").addEventListener("click", async () => {
    const result = running ? await stopInstance(id) : await startInstance(id);
    if (result.error) alert(result.error);
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

function renderActivePanel() {
  renderInstanceFilter();
  const activePanel = document.querySelector(".subtabs .st.active").dataset.panel;
  if (activePanel === "stateSubPanel") renderStatePanel();
  else if (activePanel === "actionsSubPanel") renderActionsPanel();
  else if (activePanel === "configSubPanel") renderConfigPanel();
  else renderEventsPanel();
}

document.querySelectorAll(".subtabs .st").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".subtabs .st").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".subpanel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(tab.dataset.panel).classList.add("active");
    renderActivePanel();
  });
});
instanceFilter.addEventListener("change", renderActivePanel);

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
// "slot" names a device (e.g. "kitchen light") and picks ONE instance
// plus which of that instance's actions is its On/Off/Level function -
// this is what lets a single hub-style instance (e.g. a real multi-zone
// controller) back MANY slots, each with its own fixed call arguments
// (e.g. {zone:"kitchen"}) - "kitchen light" and "living room light" can
// both point at the same instance's same lightOn/lightOff/lightSetLevel
// actions, just with a different fixed zone value. This tab is purely an
// editor - live state/toggling happens on live.html, same split QTI
// itself has between its admin bindings editor and its live pages.
//
// Simplification vs QTI: a slot's On/Off/Level functions all reference
// the SAME instance (QTI allows each to reference an independent
// instance+function) - every Oak driver built so far only ever needs one
// instance per slot, so this isn't a real limitation yet, just an honest
// scope note.
//
// Convention: a param literally named "level" on an action is the LIVE
// value (set by a drag/slider), never a fixed argument - every other
// param on the slot's chosen on/off/level actions (e.g. "zone") is
// editable as a fixed argument in the "Fixed arguments" box.
function actionParams(manifest, actionId) {
  const action = manifest && manifest.actions.find((a) => a.id === actionId);
  return action ? action.params || [] : [];
}
function fixedParamKeysForSlot(manifest, slot) {
  const keys = new Set();
  [slot.onActionId, slot.offActionId, slot.levelActionId].forEach((actionId) => {
    actionParams(manifest, actionId).forEach((p) => {
      if (p.key !== "level") keys.add(p.key);
    });
  });
  return [...keys];
}

function buildFnSelect(container, label, slot, fieldKey, onChanged) {
  const wrap = document.createElement("div");
  wrap.className = "slot-fn-group";
  const labelEl = document.createElement("div");
  labelEl.className = "lbl";
  labelEl.textContent = label;
  const actSel = document.createElement("select");
  wrap.append(labelEl, actSel);
  container.appendChild(wrap);

  function populate() {
    const manifest = manifests.get(slot.instanceId);
    actSel.innerHTML =
      `<option value="">— none —</option>` + (manifest ? manifest.actions.map((a) => `<option value="${a.id}">${a.label} (${a.id})</option>`).join("") : "");
    actSel.value = slot[fieldKey] || "";
  }
  actSel.addEventListener("change", () => {
    slot[fieldKey] = actSel.value || undefined;
    onChanged();
  });
  populate();
  return { populate };
}

// Same pattern as buildFnSelect but over manifest.states, for the
// slot's onStateId/levelStateId - kept explicit (not inferred from the
// chosen action) for the same reason server.js's roleStatesForCategory
// exists: a hub manifest can have two states plausibly matching the same
// role (zone-hub's light.level vs its unrated climate.target), so the
// slot must say which one it actually means.
function buildStateSelect(container, label, slot, fieldKey, onChanged) {
  const wrap = document.createElement("div");
  wrap.className = "slot-fn-group";
  const labelEl = document.createElement("div");
  labelEl.className = "lbl";
  labelEl.textContent = label;
  const sel = document.createElement("select");
  wrap.append(labelEl, sel);
  container.appendChild(wrap);

  function populate() {
    const manifest = manifests.get(slot.instanceId);
    sel.innerHTML =
      `<option value="">— none —</option>` + (manifest ? manifest.states.map((s) => `<option value="${s.id}">${s.id} (${s.type})</option>`).join("") : "");
    sel.value = slot[fieldKey] || "";
  }
  sel.addEventListener("change", () => {
    slot[fieldKey] = sel.value || undefined;
    onChanged();
  });
  populate();
  return { populate };
}

// Builds one slot's expandable editor: Name, an instance picker shared by
// all three functions, On/Off/Level function pickers (each scoped to
// that one instance's actions), and a "Fixed arguments" box covering
// every non-"level" param any of the three chosen actions declare (the
// zone/name selector for a hub driver). Mutates `slot` in place; the
// caller is responsible for persisting bindingsCache after a change.
function buildSlotRow(cat, slot, onDelete) {
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
  body.className = "slot-row-body hidden";
  const editBtn = document.createElement("button");
  editBtn.className = "btn small";
  editBtn.textContent = "Edit";
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

  const instWrap = document.createElement("label");
  instWrap.innerHTML = `<span class="lbl">Instance</span>`;
  const instSel = document.createElement("select");
  instWrap.appendChild(instSel);

  const argsWrap = document.createElement("div");
  argsWrap.className = "slot-fn-group";
  const argsLabel = document.createElement("div");
  argsLabel.className = "lbl";
  argsLabel.textContent = "Fixed arguments";
  argsWrap.appendChild(argsLabel);

  function renderArgs() {
    [...argsWrap.querySelectorAll("input")].forEach((el) => el.remove());
    const manifest = manifests.get(slot.instanceId);
    const keys = fixedParamKeysForSlot(manifest, slot);
    if (!keys.length) {
      const hint = document.createElement("span");
      hint.className = "sub";
      hint.textContent = "none needed";
      hint.dataset.hint = "1";
      argsWrap.appendChild(hint);
      return;
    }
    argsWrap.querySelector("[data-hint]")?.remove();
    keys.forEach((key) => {
      const paramMeta = [slot.onActionId, slot.offActionId, slot.levelActionId]
        .flatMap((aid) => actionParams(manifest, aid))
        .find((p) => p.key === key);
      const input = document.createElement("input");
      input.placeholder = (paramMeta && paramMeta.label) || key;
      input.value = (slot.fixedArgs && slot.fixedArgs[key]) || "";
      input.addEventListener("change", () => {
        slot.fixedArgs = slot.fixedArgs || {};
        if (input.value) slot.fixedArgs[key] = input.value;
        else delete slot.fixedArgs[key];
        persistBindings();
      });
      argsWrap.appendChild(input);
    });
  }
  function onFnChanged() {
    renderArgs();
    persistBindings();
  }

  const onGroup = buildFnSelect(body, "On function", slot, "onActionId", onFnChanged);
  const offGroup = buildFnSelect(body, "Off function", slot, "offActionId", onFnChanged);
  const levelGroup = buildFnSelect(body, "Level function", slot, "levelActionId", onFnChanged);
  const onStateGroup = buildStateSelect(body, "On state (for reading current on/off back)", slot, "onStateId", persistBindings);
  const levelStateGroup = buildStateSelect(body, "Level state (for reading the current level back)", slot, "levelStateId", persistBindings);

  const suffixWrap = document.createElement("label");
  suffixWrap.innerHTML = `<span class="lbl">Zone / state suffix (only for a hub instance backing multiple slots - must match what the driver reports, e.g. "kitchen")</span>`;
  const suffixInput = document.createElement("input");
  suffixInput.type = "text";
  suffixInput.value = slot.stateSuffix || "";
  suffixInput.addEventListener("change", () => {
    slot.stateSuffix = suffixInput.value.trim() || undefined;
    persistBindings();
  });
  suffixWrap.appendChild(suffixInput);

  function populateInstances() {
    instSel.innerHTML =
      `<option value="">— none —</option>` +
      instanceIds.map((id) => `<option value="${id}">${(manifests.get(id) || {}).displayName || id} (${id})</option>`).join("");
    instSel.value = slot.instanceId || "";
  }
  instSel.addEventListener("change", () => {
    slot.instanceId = instSel.value || undefined;
    slot.onActionId = slot.offActionId = slot.levelActionId = slot.onStateId = slot.levelStateId = undefined;
    onGroup.populate();
    offGroup.populate();
    levelGroup.populate();
    onStateGroup.populate();
    levelStateGroup.populate();
    renderArgs();
    persistBindings();
  });
  populateInstances();
  renderArgs();

  body.append(instWrap, argsWrap, suffixWrap);
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
    bindingsCache[cat].push({ id: Math.random().toString(16).slice(2, 10), name: `New ${CATEGORY_LABEL[cat]}`, fixedArgs: {} });
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
  slots.forEach((slot) => {
    const row = buildSlotRow(cat, slot, () => {
      bindingsCache[cat] = bindingsCache[cat].filter((s) => s !== slot);
      persistBindings();
      renderSlotList(cat, list);
    });
    list.appendChild(row);
  });
}

async function renderDashboardTab() {
  bindingsCache = await getBindings();
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
  instSel.innerHTML = instanceIds.map((id) => `<option value="${id}">${manifests.get(id).displayName} (${id})</option>`).join("");
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
fullRefresh();
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

if (location.hash.slice(1)) activateMainTab(location.hash.slice(1));
