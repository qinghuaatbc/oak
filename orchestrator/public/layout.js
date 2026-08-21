// Live rendering of a custom Layout page (bindings.pages), ported from
// QTI's own live-custom.js (QTI is this project's own prior work, not
// RTI's - reusing an already-proven design). Unlike QTI, which builds a
// separate buildXCard/refreshXCard pair per binding-array type (lights/
// media/doors/keypads/...), Oak only needs ONE such pair for the "slot"
// widget type since Oak's Dashboard is already unified around one
// generic slot shape per category - camera/macro/pageLink/appUrl/label/
// varDisplay each still get their own small builder, same as QTI.
import { listInstances, getState, getBindings, callAction, runMacro, listCameras, listMacros } from "./api.js";
import { connectWS } from "./live-socket.js";
import { attachCameraPlayer } from "./camera-player.js";
import { bindingSlot, resolveMeshOnLevel, callFn as callFnShared, primaryInstanceId, slotCallParams, effectiveCategoryIcon } from "./roles.js";

function callFn(fn, slot) {
  return callFnShared(fn, slot, { callAction, runMacro });
}

const FALLBACK_POLL_MS = 10000;
const REFRESH_DEBOUNCE_MS = 150;

let runningByInstance = new Map();
let statesByInstance = new Map();
let bindingsData = { pages: [] };
let camerasCache = [];
let macrosCache = [];
let currentPageId = null;
let widgetEls = new Map(); // widget.id -> {el, refresh(), cleanup()}

const params = new URLSearchParams(location.search);
const isPreview = params.has("preview");
const forcedPageId = params.get("page");

const tabsEl = document.getElementById("loTabs");
const canvasEl = document.getElementById("loCanvas");
const connEl = document.getElementById("conn");
const connLabelEl = document.getElementById("connlabel");

function pages() {
  return bindingsData.pages || [];
}
function currentPage() {
  return pages().find((p) => p.id === currentPageId);
}

function renderTabs() {
  [...tabsEl.querySelectorAll(".lo-tab")].forEach((el) => el.remove());
  pages().forEach((p) => {
    const btn = document.createElement("button");
    btn.className = "lo-tab" + (p.id === currentPageId ? " active" : "");
    btn.textContent = p.name;
    btn.addEventListener("click", () => switchPage(p.id));
    tabsEl.insertBefore(btn, connEl);
  });
  const activeBtn = [...tabsEl.querySelectorAll(".lo-tab")].find((b) => b.classList.contains("active"));
  if (activeBtn) activeBtn.scrollIntoView({ block: "nearest", inline: "nearest" });
}
function switchPage(id) {
  currentPageId = id;
  if (!isPreview) localStorage.setItem("oak_layout_page", id);
  renderTabs();
  renderCanvas();
}

function gridStyle(el, w) {
  el.style.gridColumn = `${w.x + 1} / span ${w.w}`;
  el.style.gridRow = `${w.y + 1} / span ${w.h}`;
  if (w.z) el.style.zIndex = w.z;
}
// A widget whose bindingId/cameraId/macroId no longer resolves (renamed/
// deleted elsewhere after this widget was placed) gets a visible broken-
// state placeholder at its correct position/size rather than silently
// vanishing - QTI's own port hit this exact bug once (an empty page and
// a page-with-one-stale-widget looked identical from the customer view,
// impossible to diagnose) and fixed it the same way.
function brokenWidget(w, message) {
  const el = document.createElement("div");
  el.className = "lo-widget lo-w-broken";
  gridStyle(el, w);
  el.textContent = `⚠ ${message}`;
  return { el, refresh: () => {}, cleanup: () => {} };
}

function buildSlotWidget(w) {
  const slot = bindingSlot(bindingsData, { cat: w.cat, id: w.slotId });
  if (!slot) return brokenWidget(w, "Widget binding missing");
  const el = document.createElement("div");
  el.className = "lo-widget";
  gridStyle(el, w);
  const hasToggle = Boolean(slot.onFn || slot.offFn);
  const hasLevel = Boolean(slot.levelFn) && w.showLevel !== false;
  if (hasToggle) el.classList.add("tappable");
  el.innerHTML = `<div class="lo-w-icon">${effectiveCategoryIcon(bindingsData.customCategories)[w.cat] || "⚙️"}</div><img class="lo-w-icon-img" style="width:26px; height:26px; object-fit:contain; display:none;" /><div class="lo-w-name">${slot.name}</div><div class="lo-w-sub"></div>`;
  const subEl = el.querySelector(".lo-w-sub");
  const iconEl = el.querySelector(".lo-w-icon");
  const iconImgEl = el.querySelector(".lo-w-icon-img");
  let sliderEl = null;
  if (hasLevel) {
    sliderEl = document.createElement("input");
    sliderEl.type = "range";
    sliderEl.min = 0;
    sliderEl.max = 100;
    sliderEl.className = "lo-slider";
    sliderEl.addEventListener("click", (ev) => ev.stopPropagation());
    sliderEl.addEventListener("change", () => {
      callAction(slot.levelFn.instanceId, slot.levelFn.actionId, slotCallParams(slot, { level: Number(sliderEl.value) }));
    });
    el.appendChild(sliderEl);
  }
  function refresh() {
    const { on, level } = resolveMeshOnLevel(bindingsData, statesByInstance, { cat: w.cat, id: w.slotId });
    el.classList.toggle("on", on);
    subEl.textContent = on ? (hasLevel ? `On · ${level}%` : "On") : "Off";
    if (sliderEl && document.activeElement !== sliderEl) sliderEl.value = level;
    el.style.opacity = runningByInstance.get(primaryInstanceId(slot)) === false ? 0.5 : 1;
    // Same on/off custom-icon-pair swap as Live's cards (see live.js's
    // buildRingCard comment) - re-applied every refresh, not just once.
    const customIcon = on ? slot.imageOn : slot.imageOff;
    if (customIcon) {
      iconImgEl.src = customIcon;
      iconImgEl.style.display = "";
      iconEl.style.display = "none";
    } else {
      iconImgEl.style.display = "none";
      iconEl.style.display = "";
    }
  }
  if (hasToggle) {
    el.addEventListener("click", () => {
      const { on } = resolveMeshOnLevel(bindingsData, statesByInstance, { cat: w.cat, id: w.slotId });
      const fn = on ? slot.offFn : slot.onFn;
      if (fn) callFn(fn, slot).then(() => scheduleRefresh());
    });
  }
  refresh();
  return { el, refresh, cleanup: () => {} };
}
function buildCameraWidget(w) {
  const cam = camerasCache.find((c) => c.id === w.cameraId);
  if (!cam) return brokenWidget(w, "Camera missing");
  const el = document.createElement("div");
  el.className = "lo-widget";
  gridStyle(el, w);
  el.innerHTML = `<div class="lo-w-name">📷 ${cam.name}</div>`;
  const video = document.createElement("video");
  video.className = "lo-w-video";
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  el.appendChild(video);
  // Owns a live WS/MediaSource connection that outlives the DOM node it's
  // attached to if not explicitly stopped - QTI's own port of this widget
  // leaked exactly this way on re-render before fixing it; cleanup() is
  // called by renderCanvas() before every full teardown, not left to GC.
  const player = attachCameraPlayer(video, cam.rtspUrl);
  return { el, refresh: () => {}, cleanup: () => player.stop() };
}
function buildMacroWidget(w) {
  const macro = macrosCache.find((m) => m.id === w.macroId);
  if (!macro) return brokenWidget(w, "Macro missing");
  const el = document.createElement("div");
  el.className = "lo-widget tappable";
  gridStyle(el, w);
  el.innerHTML = `<div class="lo-w-icon">▶️</div><div class="lo-w-name">${macro.name}</div>`;
  el.addEventListener("click", () => runMacro(macro.id));
  return { el, refresh: () => {}, cleanup: () => {} };
}
function buildPageLinkWidget(w) {
  const el = document.createElement("div");
  el.className = "lo-widget tappable";
  gridStyle(el, w);
  el.innerHTML = `<div class="lo-w-icon">🔗</div><div class="lo-w-name">${w.label || "Link"}</div>`;
  el.addEventListener("click", () => switchPage(w.targetPageId));
  return { el, refresh: () => {}, cleanup: () => {} };
}
function buildAppUrlWidget(w) {
  const el = document.createElement("div");
  el.className = "lo-widget tappable";
  gridStyle(el, w);
  el.innerHTML = `<div class="lo-w-icon">🌐</div><div class="lo-w-name">${w.label || "Link"}</div>`;
  el.addEventListener("click", () => window.open(w.url, w.openInNewTab ? "_blank" : "_self"));
  return { el, refresh: () => {}, cleanup: () => {} };
}
// No driver involved at all - just an iframe pointed at a URL, same "enter a
// URL, done" simplicity as the Camera widget's rtspUrl field, but without
// Camera's server-side RTSP-to-WS transcode pipeline: an iframe can only load
// content that's already a normal web page, so nothing server-side is needed
// (or possible) here. Sites that send X-Frame-Options/CSP frame-ancestors
// (most banks, some SaaS admin panels) will refuse to render inside the
// iframe - that's the target site's own choice, not fixable from this side.
function buildWebObjectWidget(w) {
  const el = document.createElement("div");
  el.className = "lo-widget lo-w-webobject";
  gridStyle(el, w);
  const frame = document.createElement("iframe");
  frame.className = "lo-w-frame";
  frame.src = w.url || "about:blank";
  el.appendChild(frame);
  return { el, refresh: () => {}, cleanup: () => {} };
}
function buildLabelWidget(w) {
  const el = document.createElement("div");
  el.className = "lo-widget";
  gridStyle(el, w);
  el.innerHTML = `<div class="lo-w-name" style="font-size:16px;">${w.text || ""}</div>`;
  return { el, refresh: () => {}, cleanup: () => {} };
}
function buildVarDisplayWidget(w) {
  const el = document.createElement("div");
  el.className = "lo-widget";
  gridStyle(el, w);
  el.innerHTML = `<div class="lo-w-name">${w.label || "Value"}</div><div class="lo-w-sub" style="font-size:18px; font-weight:700; color:var(--ink);"></div>`;
  const valEl = el.querySelector(".lo-w-sub");
  function refresh() {
    const state = statesByInstance.get(w.instanceId) || {};
    const key = w.stateSuffix ? `${w.stateId}#${w.stateSuffix}` : w.stateId;
    const val = state[key];
    valEl.textContent = val !== undefined ? String(val) : "—";
  }
  refresh();
  return { el, refresh, cleanup: () => {} };
}
function buildWidget(w) {
  if (w.type === "slot") return buildSlotWidget(w);
  if (w.type === "camera") return buildCameraWidget(w);
  if (w.type === "macro") return buildMacroWidget(w);
  if (w.type === "pageLink") return buildPageLinkWidget(w);
  if (w.type === "appUrl") return buildAppUrlWidget(w);
  if (w.type === "webObject") return buildWebObjectWidget(w);
  if (w.type === "label") return buildLabelWidget(w);
  if (w.type === "varDisplay") return buildVarDisplayWidget(w);
  return brokenWidget(w, "Unknown widget type");
}

function renderCanvas() {
  for (const entry of widgetEls.values()) entry.cleanup();
  widgetEls.clear();
  canvasEl.innerHTML = "";
  const page = currentPage();
  if (!page) {
    canvasEl.innerHTML = `<p class="lo-empty">No layout pages configured yet - add one on the admin Layout tab.</p>`;
    return;
  }
  canvasEl.style.backgroundImage = page.background && page.background.url ? `url(${page.background.url})` : "";
  if (!page.widgets.length) {
    canvasEl.innerHTML = `<p class="lo-empty">This page has no widgets yet.</p>`;
    return;
  }
  page.widgets.forEach((w) => {
    const entry = buildWidget(w);
    widgetEls.set(w.id, entry);
    canvasEl.appendChild(entry.el);
  });
}

async function refresh() {
  const list = await listInstances();
  await Promise.all(
    list.map(async (summary) => {
      runningByInstance.set(summary.id, summary.running);
      statesByInstance.set(summary.id, await getState(summary.id));
    })
  );
  for (const entry of widgetEls.values()) entry.refresh();
}
let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, REFRESH_DEBOUNCE_MS);
}

async function loadBindingsAndRender() {
  bindingsData = await getBindings();
  if (forcedPageId && pages().some((p) => p.id === forcedPageId)) {
    currentPageId = forcedPageId;
  } else if (!currentPageId || !currentPage()) {
    const saved = !isPreview && localStorage.getItem("oak_layout_page");
    currentPageId = (saved && pages().some((p) => p.id === saved) ? saved : (pages()[0] || {}).id) || null;
  }
  renderTabs();
  renderCanvas();
}

async function bootstrap() {
  const [cams, macroList] = await Promise.all([listCameras(), listMacros()]);
  camerasCache = cams;
  macrosCache = macroList;
  await loadBindingsAndRender();
  await refresh();
}
bootstrap();

const WS = connectWS();
WS.onPush((msg) => {
  if (msg.type === "bindings" && msg.bindings) {
    bindingsData = msg.bindings;
    renderTabs();
    renderCanvas();
  }
  if (msg.type === "macrosChanged") listMacros().then((m) => (macrosCache = m));
  scheduleRefresh();
});
WS.onStatus((connected) => {
  connEl.classList.toggle("connected", connected);
  connLabelEl.textContent = connected ? "connected" : "connecting";
  if (connected) scheduleRefresh();
});
setInterval(refresh, FALLBACK_POLL_MS);
