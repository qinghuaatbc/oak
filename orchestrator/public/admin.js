import {
  listInstances, getManifest, getState, callAction, listDrivers, addInstance, deleteInstance,
  getConfig, editInstance, stopInstance, startInstance,
  getHealth, listMacros, saveMacro, deleteMacro, runMacro,
  listCameras, addCamera, deleteCamera, listGlbModels, uploadGlb,
  uploadDriver, deleteDriverPackage,
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
let categoriesByInstance = new Map(); // id -> string[] (effective, override-aware)
let dashboardMetaByInstance = new Map(); // id -> {hidden: boolean, label: string|undefined}
let dashboardCat = "__all__";
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

  // Category is pure presentation metadata (which Dashboard/Live sections
  // this instance shows up under) - editable regardless of running state,
  // unlike connection/settings which need the instance stopped first. The
  // manifest's own declared default is shown even when overridden, so
  // "reset to default" is just unchecking back to that set.
  const defaultCats = Array.isArray(driverManifest.category) ? driverManifest.category : [driverManifest.category || "generic"];
  const activeCats = effectiveCategories(manifest, cfg.categoryOverride);
  const catCheckboxes = CATEGORY_ORDER.map(
    (c) =>
      `<label style="display:inline-flex; align-items:center; gap:4px; margin-right:12px;"><input type="checkbox" name="cat" value="${c}" ${
        activeCats.includes(c) ? "checked" : ""
      } />${CATEGORY_ICON[c]} ${CATEGORY_LABEL[c]}${defaultCats.includes(c) ? " (default)" : ""}</label>`
  ).join("");

  configPanel.innerHTML = `
    <p class="sub">instance "${id}" · driver ${manifest.id} · ${running ? "running" : "stopped"}</p>
    <form id="editCategoryForm" class="config-form">
      <span class="lbl">Dashboard/Live categories</span>
      <div style="margin:6px 0 10px;">${catCheckboxes}</div>
      <button class="btn small primary" type="submit">Save categories</button>
    </form>
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

  document.getElementById("editCategoryForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const checked = [...ev.target.querySelectorAll('input[name="cat"]:checked')].map((i) => i.value);
    // An override that exactly matches the manifest's own default is the
    // same as no override at all - clearing it (rather than persisting a
    // redundant copy) means a future driver update to its own default
    // category keeps applying, instead of being silently frozen out by a
    // stale override nobody meant to set in stone.
    const sameAsDefault = checked.length === defaultCats.length && checked.every((c) => defaultCats.includes(c));
    const result = await editInstance(id, { categoryOverride: sameAsDefault ? [] : checked });
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
        if (input.name === "cat") return;
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
  if (page === "dashboard") renderDashboard();
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

// --- Dashboard: category is the tab - each category present across the
// configured instances gets its own subtab (same subtabs widget the
// Driver tab's State/Actions/Events/Config already use), not just a
// heading in one long scroll. An instance with multiple declared
// categories (a hub-style driver, e.g. a real Eisy-equivalent controlling
// both lights and a thermostat through one instance) appears under every
// one of them - Oak has no driver yet whose actions/states are annotated
// finely enough to split a single instance's controls into separate per-
// category widgets, so showing the whole instance card in each relevant
// tab is the honest v1 scope. ---
function renderDashboardCatTabs() {
  const tabsEl = document.getElementById("dashboardCatTabs");
  const present = new Set();
  instanceIds.forEach((id) => (categoriesByInstance.get(id) || []).forEach((c) => present.add(c)));
  const cats = CATEGORY_ORDER.filter((c) => present.has(c));
  if (!cats.some((c) => c === dashboardCat) && dashboardCat !== "__all__") dashboardCat = "__all__";
  const allTab = `<div class="st${dashboardCat === "__all__" ? " active" : ""}" data-cat="__all__">All</div>`;
  const catTabs = cats
    .map((c) => `<div class="st${dashboardCat === c ? " active" : ""}" data-cat="${c}">${CATEGORY_ICON[c] || "⚙️"} ${CATEGORY_LABEL[c] || c}</div>`)
    .join("");
  tabsEl.innerHTML = allTab + catTabs;
  tabsEl.querySelectorAll(".st").forEach((tab) => {
    tab.addEventListener("click", () => {
      dashboardCat = tab.dataset.cat;
      renderDashboard();
    });
  });
}

function dashboardLabelFor(id) {
  const meta = dashboardMetaByInstance.get(id);
  return (meta && meta.label) || manifests.get(id).displayName;
}

// Tiles are auto-generated from the driver's own manifest by default (same
// name/category the driver declares), but each one carries two small,
// presentation-only overrides an admin can set without touching the
// instance's connection/settings: a custom tile label, and hide-from-
// dashboard (the instance keeps running, it's just not shown here). This is
// the "auto-generate, but editable" middle ground between Oak's own
// auto-category tiles and QTI's fully-manual, freely add/delete-able slot
// system - Oak doesn't have freeform unbound slots, so "add" here means
// "un-hide", not "create a tile with no backing instance".
function renderDashboard() {
  renderDashboardCatTabs();
  const grid = document.getElementById("dashboardGrid");
  grid.innerHTML = "";
  const inCat = (id) => dashboardCat === "__all__" || (categoriesByInstance.get(id) || []).includes(dashboardCat);
  const candidates = instanceIds.filter(inCat);
  const visible = candidates.filter((id) => !(dashboardMetaByInstance.get(id) || {}).hidden);
  const hidden = candidates.filter((id) => (dashboardMetaByInstance.get(id) || {}).hidden);
  if (!visible.length) {
    grid.innerHTML = `<p class="empty-hint">No instances in this category.</p>`;
  }
  visible.forEach((id) => {
    const manifest = manifests.get(id);
    const running = runningByInstance.get(id);
    const state = statesByInstance.get(id) || {};
    const label = dashboardLabelFor(id);
    const wrap = document.createElement("div");
    wrap.className = "tile";
    const editHtml = `<span class="tile-edit-btns" onclick="event.stopPropagation()">
      <button class="icon-btn" data-edit-label="${id}" title="Rename tile">✎</button>
      <button class="icon-btn" data-hide-tile="${id}" title="Remove from dashboard">✕</button>
    </span>`;
    if (!running) {
      wrap.innerHTML = `<div class="row" style="justify-content:space-between;"><div class="tname">${label}</div>${editHtml}</div><div class="tstate">stopped</div>`;
      grid.appendChild(wrap);
      return;
    }
    const togglePair = getOnOffPair(manifest);
    const boolEntry = Object.entries(state).find(([, v]) => typeof v === "boolean");
    const useToggle = Boolean(togglePair && boolEntry);
    const switchHtml = useToggle
      ? `<label class="switch" onclick="event.stopPropagation()"><input type="checkbox" ${
          boolEntry[1] ? "checked" : ""
        } data-instance="${id}" data-on-action="${togglePair[0]}" data-off-action="${togglePair[1]}" /><span class="slider-track"></span></label>`
      : "";
    const stateText = Object.entries(state)
      .map(([k, v]) => (typeof v === "boolean" ? (v ? "ON" : "OFF") : String(v)))
      .join(" · ");
    wrap.innerHTML = `
      <div class="row" style="justify-content:space-between;">
        <span class="tname">${label}</span>
        ${editHtml}
      </div>
      <div class="row">
        ${switchHtml}
      </div>
      <div class="tstate">${stateText || "—"}</div>`;
    grid.appendChild(wrap);
  });
  if (hidden.length) {
    const hiddenWrap = document.createElement("div");
    hiddenWrap.style.cssText = "grid-column:1/-1; margin-top:14px; padding-top:10px; border-top:1px solid var(--line);";
    hiddenWrap.innerHTML = `<div class="sub" style="margin-bottom:8px;">Hidden from dashboard</div>`;
    hidden.forEach((id) => {
      const row = document.createElement("span");
      row.style.cssText = "display:inline-flex; align-items:center; gap:6px; margin:0 12px 8px 0;";
      row.innerHTML = `<span class="sub">${dashboardLabelFor(id)}</span><button class="btn small" data-show-tile="${id}">+ Add to dashboard</button>`;
      hiddenWrap.appendChild(row);
    });
    grid.appendChild(hiddenWrap);
  }
  grid.querySelectorAll("input[type=checkbox][data-on-action]").forEach((input) => {
    input.addEventListener("change", async () => {
      const action = input.checked ? input.dataset.onAction : input.dataset.offAction;
      try {
        await callAction(input.dataset.instance, action, {});
      } catch (err) {
        console.error("action failed", err);
      }
    });
  });
  grid.querySelectorAll("[data-hide-tile]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await editInstance(btn.dataset.hideTile, { dashboardHidden: true });
      await fullRefresh();
    });
  });
  grid.querySelectorAll("[data-show-tile]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await editInstance(btn.dataset.showTile, { dashboardHidden: false });
      await fullRefresh();
    });
  });
  grid.querySelectorAll("[data-edit-label]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.editLabel;
      const current = dashboardLabelFor(id);
      const next = prompt("Dashboard tile label:", current);
      if (next === null) return;
      const trimmed = next.trim();
      const isDefault = trimmed === manifests.get(id).displayName;
      await editInstance(id, { dashboardLabel: isDefault ? "" : trimmed });
      await fullRefresh();
    });
  });
}

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
      categoriesByInstance.set(summary.id, effectiveCategories(manifests.get(summary.id), summary.categoryOverride));
      dashboardMetaByInstance.set(summary.id, { hidden: Boolean(summary.dashboardHidden), label: summary.dashboardLabel });
      statesByInstance.set(summary.id, await getState(summary.id));
    })
  );
  updateCountPill();
  renderInstancesList();
  renderActivePanel();
  const mainTab = activeMainTab();
  if (mainTab === "dashboard") renderDashboard();
  else if (mainTab === "health") renderHealthTab();
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
