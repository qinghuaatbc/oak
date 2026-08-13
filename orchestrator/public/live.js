// Live view: sidebar-by-driver-type + frosted-glass sky-card grid, ported
// from QTI's own live.js/live.html structure (sky-wrap/sky-sidebar/
// sky-card) - simplified to plain icon+label+buttons cards since Oak has
// no dimmable/level-type state yet to justify QTI's ring-dial widget.
import { listInstances, getManifest, getState, callAction } from "./api.js";
import { connectLiveSocket } from "./live-socket.js";

const FALLBACK_POLL_MS = 10000;
const REFRESH_DEBOUNCE_MS = 150;
const DRIVER_ICONS = { "dsc-powerseries": "🔒", "http-relay": "🔌", "mqtt-plug": "📡" };
const DRIVER_ICON_FALLBACK = "⚙️";

const grid = document.getElementById("skyGrid");
const sidebar = document.getElementById("skySidebar");
let manifests = new Map();
let activeCat = "__all__";

// See admin.js's identical helper for why armStay/disarm is deliberately
// NOT in this list: matching by action id alone isn't enough - DSC's
// partition.status is a string, not boolean, so treating it as a toggle
// pair silently dropped "disarm" from the UI (its button was skipped
// assuming the pair's other button covered it) while "Turn Stay" always
// showed "Turn On" and never reflected real state. Fixed the same way:
// callers gate on `useToggle` (pair AND a real boolean state), not on
// `togglePair` alone.
function findTogglePair(manifest) {
  const ids = new Set(manifest.actions.map((a) => a.id));
  const pairs = [["turnOn", "turnOff"]];
  return pairs.find(([on, off]) => ids.has(on) && ids.has(off));
}

function buildCard(instanceId, manifest, state) {
  const icon = DRIVER_ICONS[manifest.id] || DRIVER_ICON_FALLBACK;
  const togglePair = findTogglePair(manifest);
  const boolEntry = Object.entries(state).find(([, v]) => typeof v === "boolean");
  const useToggle = Boolean(togglePair && boolEntry);
  const on = boolEntry ? boolEntry[1] : false;

  const card = document.createElement("div");
  card.className = "sky-card";
  card.dataset.category = manifest.id;
  card.dataset.on = on ? "1" : "0";

  const iconEl = document.createElement("div");
  iconEl.className = "sky-icon";
  iconEl.textContent = icon;

  const valueEl = document.createElement("div");
  valueEl.className = "sky-value";
  valueEl.textContent = Object.keys(state).length
    ? Object.entries(state)
        .map(([k, v]) => (typeof v === "boolean" ? (v ? "ON" : "OFF") : String(v)))
        .join(" · ")
    : "—";

  const labelEl = document.createElement("div");
  labelEl.className = "sky-label";
  labelEl.textContent = manifest.displayName;

  const actionsEl = document.createElement("div");
  actionsEl.className = "sky-actions";
  manifest.actions.forEach((a) => {
    if (useToggle && a.id === togglePair[1]) return; // toggle pair -> one tap target, not two buttons
    const btn = document.createElement("button");
    btn.className = "sky-action-btn" + (useToggle && a.id === togglePair[0] ? " primary" : "");
    btn.textContent = useToggle && a.id === togglePair[0] ? (on ? "Turn Off" : "Turn On") : a.label;
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const actionId = useToggle && a.id === togglePair[0] ? (on ? togglePair[1] : togglePair[0]) : a.id;
      try {
        await callAction(instanceId, actionId, {});
      } catch (err) {
        console.error("action failed", err);
      }
      scheduleRefresh();
    });
    actionsEl.appendChild(btn);
  });

  card.append(iconEl, valueEl, labelEl, actionsEl);
  return card;
}

function renderSidebar(categories) {
  const cats = [...categories];
  sidebar.innerHTML = "";
  const allBtn = document.createElement("button");
  allBtn.className = "sky-cat" + (activeCat === "__all__" ? " active" : "");
  allBtn.innerHTML = `<span>☰</span><span>All</span>`;
  allBtn.addEventListener("click", () => setActiveCategory("__all__"));
  sidebar.appendChild(allBtn);
  cats.forEach((driverId) => {
    const btn = document.createElement("button");
    btn.className = "sky-cat" + (activeCat === driverId ? " active" : "");
    // Driver id, not the first word of displayName - two different drivers
    // both named "Generic ..." (http-relay, mqtt-plug) rendered identical,
    // indistinguishable "Generic" sidebar labels otherwise.
    const label = driverId
      .split("-")
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(" ");
    btn.innerHTML = `<span>${DRIVER_ICONS[driverId] || DRIVER_ICON_FALLBACK}</span><span>${label}</span>`;
    btn.addEventListener("click", () => setActiveCategory(driverId));
    sidebar.appendChild(btn);
  });
}

function setActiveCategory(cat) {
  activeCat = cat;
  refresh(); // renderSidebar (called from refresh) re-derives .active from activeCat
}

async function refresh() {
  const list = await listInstances();
  const cards = await Promise.all(
    list.map(async (summary) => {
      if (!manifests.has(summary.id)) manifests.set(summary.id, await getManifest(summary.id));
      const manifest = manifests.get(summary.id);
      const state = await getState(summary.id);
      return { instanceId: summary.id, manifest, state };
    })
  );

  renderSidebar(new Set(cards.map((c) => c.manifest.id)));

  const visible = activeCat === "__all__" ? cards : cards.filter((c) => c.manifest.id === activeCat);
  grid.innerHTML = "";
  if (!visible.length) {
    grid.innerHTML = `<p class="empty">No instances to show.</p>`;
    return;
  }
  visible.forEach(({ instanceId, manifest, state }) => grid.appendChild(buildCard(instanceId, manifest, state)));
}

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, REFRESH_DEBOUNCE_MS);
}

const connEl = document.getElementById("conn");
const connLabel = document.getElementById("connlabel");

refresh();
connectLiveSocket(
  () => scheduleRefresh(),
  (connected) => {
    connEl.classList.toggle("connected", connected);
    connLabel.textContent = connected ? "connected" : "connecting";
  }
);
setInterval(refresh, FALLBACK_POLL_MS);
