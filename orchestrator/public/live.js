// Live view: category sidebar + frosted-glass sky-card grid, ported from
// QTI's own live.js/live.html structure (sky-wrap/sky-sidebar/sky-card,
// ring-dial geometry). Cards render bindings.json SLOTS now, not driver
// instances directly - a slot names a device (e.g. "kitchen") and picks
// one instance + its on/off/level functions, so one hub-style instance
// can back many cards (see roles.js's header comment). Cards are built
// once per slot and updated in place afterward (cardEls Map), not
// rebuilt from scratch on every refresh - QTI's own shared.js has a
// direct comment on why: a full rebuild mid-drag is exactly the bug that
// bit its admin tile grid once already, and the ring widget below needs
// real dragging to work at all.
import { listInstances, getState, callAction, getBindings, runMacro } from "./api.js";
import { connectWS } from "./live-socket.js";
import { createCommPanel } from "./comm.js";
import {
  CATEGORY_ICON,
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  slotCallParams,
  primaryInstanceId,
  slotOnEntry,
  slotLevelValue,
  callFn as callFnShared,
  bindingSlot,
  resolveMeshOnLevel,
} from "./roles.js";
import { create3DPanel } from "./live-3d.js";

// Thin wrapper binding roles.js's generic callFn to this page's api.js
// imports - see roles.js for why callFn takes callAction/runMacro as
// params instead of importing api.js itself (so viewer3d.js's dispatch
// path, wired up in live-3d.js, can share the exact same function).
function callFn(fn, slot) {
  return callFnShared(fn, slot, { callAction, runMacro });
}

const FALLBACK_POLL_MS = 10000;
const REFRESH_DEBOUNCE_MS = 150;

const grid = document.getElementById("skyGrid");
const sidebar = document.getElementById("skySidebar");
const live3dPanelEl = document.getElementById("live3dPanel");
let runningByInstance = new Map(); // instanceId -> boolean
let statesByInstance = new Map(); // instanceId -> {key: value}
let bindingsData = Object.fromEntries(CATEGORY_ORDER.map((c) => [c, []])); // cat -> slot[]
let cardEls = new Map(); // slotId -> {el, apply(state, running), cat}
let activeCat = "__all__";

// A bound 3D mesh's tap toggles its device exactly like a flat card's tap
// does - resolve current on/off via the same shared helper the card grid
// uses, then call whichever of On/Off is appropriate.
function dispatch3DMeshClick(mb) {
  const slot = bindingSlot(bindingsData, mb);
  if (!slot) return;
  const { on } = resolveMeshOnLevel(bindingsData, statesByInstance, mb);
  const fn = on ? slot.offFn : slot.onFn;
  if (!fn) return;
  const turningOn = !on;
  callFn(fn, slot)
    .then(() => panel3d.refresh())
    .catch((e) => console.error("3D mesh action failed", e));
  feedbackToggle(slot.name, turningOn);
}
const panel3d = create3DPanel({
  sceneRowId: "live3dSceneRow",
  getBindingsData: () => bindingsData,
  getStatesByInstance: () => statesByInstance,
  dispatchToggle: dispatch3DMeshClick,
});

// ---------------------------------------------------------------------
// Ring-dial geometry - identical constants/math to QTI's own live.js
// (itself ported from workshop/web_dashboard's WebDashboard.js).
// ---------------------------------------------------------------------
const RING_S = 160,
  RING_CX = 80,
  RING_CY = 80,
  RING_R_ARC = 64,
  RING_START = 135,
  RING_SPAN = 270;
const SVG_NS = "http://www.w3.org/2000/svg";

function ringPolar(angle, r) {
  const a = (angle * Math.PI) / 180;
  return [RING_CX + r * Math.cos(a), RING_CY + r * Math.sin(a)];
}
function ringArc(startAngle, spanDeg, r) {
  if (spanDeg <= 0) return "";
  const clipped = Math.min(spanDeg, RING_SPAN - 0.1);
  const [sx, sy] = ringPolar(startAngle, r);
  const [ex, ey] = ringPolar(startAngle + clipped, r);
  return `M ${sx.toFixed(2)} ${sy.toFixed(2)} A ${r} ${r} 0 ${clipped > 180 ? 1 : 0} 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`;
}
const RING_TRACK_D = ringArc(RING_START, RING_SPAN, RING_R_ARC);
function ringAngleToProgress(raw) {
  if (raw >= RING_START) return Math.min((raw - RING_START) / RING_SPAN, 1);
  if (raw <= RING_START - 360 + RING_SPAN) return Math.min((raw + 360 - RING_START) / RING_SPAN, 1);
  return raw <= 90 ? 1 : 0;
}
function ringProgressFromEvent(svgEl, evt) {
  const rect = svgEl.getBoundingClientRect();
  const scale = rect.width / RING_S;
  const raw = ((Math.atan2(evt.clientY - rect.top - RING_CY * scale, evt.clientX - rect.left - RING_CX * scale) * 180) / Math.PI + 360) % 360;
  return ringAngleToProgress(raw);
}

// A ring-dial card for any slot with a Level function bound - tap toggles
// on/off (via the slot's On/Off functions, if either is bound - each may
// be a single action call or a macro run), drag sets level. The center
// glyph follows the slot's own category, not a hardcoded light bulb - a
// climate slot's ring shows 🌡️, a media slot 🎬, etc., so this one widget
// works for any category with a live-adjustable value, not just dimmers.
function buildRingCard(slot, cat) {
  const hasToggle = Boolean(slot.onFn || slot.offFn);

  const box = document.createElement("div");
  box.className = "sky-card";
  box.dataset.on = "0";

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "sky-ring");
  svg.setAttribute("viewBox", `0 0 ${RING_S} ${RING_S}`);
  const track = document.createElementNS(SVG_NS, "path");
  track.setAttribute("class", "ring-track");
  track.setAttribute("d", RING_TRACK_D);
  const val = document.createElementNS(SVG_NS, "path");
  val.setAttribute("class", "ring-val");
  const thumb = document.createElementNS(SVG_NS, "circle");
  thumb.setAttribute("class", "ring-thumb");
  thumb.setAttribute("r", "9");
  const bulb = document.createElementNS(SVG_NS, "text");
  bulb.setAttribute("class", "ring-bulb");
  bulb.setAttribute("x", "80");
  bulb.setAttribute("y", "88");
  bulb.textContent = CATEGORY_ICON[cat] || "⚙️";
  // Custom on/off icon pair (set on the Dashboard tab) - an SVG <image>
  // laid over the same center spot the emoji glyph occupies, an on/off
  // PAIR not a single image (a slider's level has no sensible per-value
  // image, only its on/off state does), swapped every applyVisual() call
  // rather than once at build time so a later admin edit or state change
  // is never left showing a stale icon.
  const iconImg = document.createElementNS(SVG_NS, "image");
  iconImg.setAttribute("class", "ring-icon-img");
  iconImg.setAttribute("x", "50");
  iconImg.setAttribute("y", "50");
  iconImg.setAttribute("width", "60");
  iconImg.setAttribute("height", "60");
  iconImg.style.display = "none";
  svg.append(track, val, thumb, bulb, iconImg);
  box.appendChild(svg);

  const valueEl = document.createElement("div");
  valueEl.className = "sky-value";
  const labelEl = document.createElement("div");
  labelEl.className = "sky-label";
  labelEl.textContent = slot.name;
  const offlineEl = document.createElement("div");
  offlineEl.className = "sky-offline-badge sky-hidden";
  box.append(valueEl, labelEl, offlineEl);

  function applyVisual(value, on) {
    val.setAttribute("d", ringArc(RING_START, (value / 100) * RING_SPAN, RING_R_ARC));
    const [tx, ty] = ringPolar(RING_START + (value / 100) * RING_SPAN, RING_R_ARC);
    thumb.setAttribute("cx", tx.toFixed(2));
    thumb.setAttribute("cy", ty.toFixed(2));
    const customIcon = on ? slot.imageOn : slot.imageOff;
    if (customIcon) {
      iconImg.setAttribute("href", customIcon);
      iconImg.style.display = "";
      bulb.style.display = "none";
    } else {
      iconImg.style.display = "none";
      bulb.style.display = "";
      bulb.style.opacity = on ? Math.max(0.35, value / 100) : 0.25;
    }
    valueEl.textContent = on ? String(value) : "—";
    box.dataset.on = on ? "1" : "0";
  }
  applyVisual(0, false);

  // Tap-vs-drag decided by distance from where the pointer first went
  // down, not from the ring center - QTI's own comment explains why: the
  // ring track sits near the outer edge, so a center-distance check
  // misreads nearly every tap as a tiny drag.
  const DRAG_THRESHOLD_PX = 8;
  let dragging = false;
  let didDrag = false;
  let throttleTimer = null;
  let pendingValue = null;
  let downX = 0;
  let downY = 0;
  // A drag/tap optimistically paints its own target value immediately,
  // but the confirmed value (statesByInstance, refreshed via poll/WS
  // push) only catches up once the real device - eisy or Home Assistant,
  // both genuine network round trips, not instant like a mock - reports
  // back. Without this, refresh()'s unconditional apply() call (which can
  // fire many times a second while a real driver is streaming state
  // events) paints the stale pre-drag value the instant it arrives,
  // before the real echo does - a visible snap-back-then-forward "bounce"
  // on every drag. Held for a grace window (matched by-eye against real
  // eisy/HA round-trip latency) or until the fetched value actually
  // agrees, whichever comes first - so a genuinely external change (someone
  // else, or a physical switch) still wins once it's for real.
  const OPTIMISTIC_HOLD_MS = 4000;
  const OPTIMISTIC_AGREE_TOLERANCE = 2;
  let optimisticValue = null;
  let optimisticOn = null;
  let optimisticExpire = 0;
  function setOptimistic(v, on) {
    optimisticValue = v;
    optimisticOn = on;
    optimisticExpire = Date.now() + OPTIMISTIC_HOLD_MS;
  }

  svg.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    dragging = true;
    didDrag = false;
    downX = ev.clientX;
    downY = ev.clientY;
    svg.setPointerCapture(ev.pointerId);
  });
  svg.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    if (!didDrag) {
      if (Math.hypot(ev.clientX - downX, ev.clientY - downY) < DRAG_THRESHOLD_PX) return;
      didDrag = true;
    }
    const v = Math.round(ringProgressFromEvent(svg, ev) * 100);
    applyVisual(v, true);
    setOptimistic(v, true);
    pendingValue = v;
    if (!throttleTimer) {
      throttleTimer = setTimeout(() => {
        throttleTimer = null;
        callAction(slot.levelFn.instanceId, slot.levelFn.actionId, slotCallParams(slot, { level: pendingValue })).catch((e) => console.error("level action failed", e));
      }, 200);
    }
  });
  svg.addEventListener("pointerup", (ev) => {
    if (!dragging) return;
    dragging = false;
    if (!didDrag) {
      if (!hasToggle) return;
      const turningOn = box.dataset.on !== "1";
      const fn = turningOn ? slot.onFn : slot.offFn;
      if (!fn) return;
      callFn(fn, slot).catch((e) => console.error("action failed", e));
      feedbackToggle(slot.name, turningOn);
      setOptimistic(turningOn ? 100 : 0, turningOn);
      scheduleRefresh();
      return;
    }
    const v = Math.round(ringProgressFromEvent(svg, ev) * 100);
    applyVisual(v, true);
    setOptimistic(v, true);
    callAction(slot.levelFn.instanceId, slot.levelFn.actionId, slotCallParams(slot, { level: v })).catch((e) => console.error("level action failed", e));
  });

  function apply() {
    const running = Boolean(runningByInstance.get(primaryInstanceId(slot)));
    box.classList.toggle("offline", !running);
    offlineEl.classList.toggle("sky-hidden", running);
    offlineEl.textContent = langZh ? "离线" : "offline";
    // Mid-drag, the pointermove handler above already owns the visual -
    // overwriting it here with the not-yet-caught-up fetched state is
    // exactly the bounce this whole optimistic-hold mechanism exists to
    // prevent.
    if (dragging) return;
    const onState = slot.onState && (statesByInstance.get(slot.onState.instanceId) || {});
    const levelState = slot.levelState && (statesByInstance.get(slot.levelState.instanceId) || {});
    const onEntry = onState ? slotOnEntry(slot, onState) : undefined;
    const levelValue = levelState ? slotLevelValue(slot, levelState) : undefined;
    const on = onEntry ? onEntry[1] : levelValue > 0;
    const fetchedValue = levelValue !== undefined ? levelValue : on ? 100 : 0;
    if (optimisticValue !== null) {
      const agrees = Math.abs(fetchedValue - optimisticValue) <= OPTIMISTIC_AGREE_TOLERANCE && on === optimisticOn;
      if (agrees || Date.now() > optimisticExpire) {
        optimisticValue = null;
        optimisticOn = null;
      } else {
        applyVisual(optimisticValue, optimisticOn);
        return;
      }
    }
    applyVisual(fetchedValue, on);
  }

  return { el: box, apply, cat };
}

// Plain card (icon + value text + one On/Off button) for a slot with no
// Level function bound - switches, security arm/disarm, and anything
// else where a single toggle covers it. A slot's binding is only ever
// on/off/level (unlike Oak's earlier instance-tile model, which could
// show a driver's ENTIRE action list as separate buttons) - other
// actions on the underlying driver are reachable from the admin's Driver
// tab, not from a Dashboard slot.
function buildPlainCard(slot, cat) {
  const icon = CATEGORY_ICON[cat] || "⚙️";
  const hasToggle = Boolean(slot.onFn || slot.offFn);

  const card = document.createElement("div");
  card.className = "sky-card";
  card.dataset.on = "0";

  const iconEl = document.createElement("div");
  iconEl.className = "sky-icon";
  iconEl.textContent = icon;
  // Same on/off custom-icon-pair swap as the ring card - see its own
  // comment for why it's a pair, not a single image, and why this is
  // re-applied every apply() call rather than set once at build time.
  const iconImg = document.createElement("img");
  iconImg.style.cssText = "width:36px; height:36px; object-fit:contain; display:none;";
  const valueEl = document.createElement("div");
  valueEl.className = "sky-value";
  const labelEl = document.createElement("div");
  labelEl.className = "sky-label";
  labelEl.textContent = slot.name;
  const offlineEl = document.createElement("div");
  offlineEl.className = "sky-offline-badge sky-hidden";
  const actionsEl = document.createElement("div");
  actionsEl.className = "sky-actions";

  if (hasToggle) {
    const btn = document.createElement("button");
    btn.className = "sky-action-btn primary";
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const on = card.dataset.on === "1";
      const fn = on ? slot.offFn : slot.onFn;
      if (!fn) return;
      try {
        await callFn(fn, slot);
      } catch (err) {
        console.error("action failed", err);
      }
      feedbackToggle(slot.name, !on);
      scheduleRefresh();
    });
    actionsEl.appendChild(btn);
  }

  card.append(iconEl, iconImg, valueEl, labelEl, offlineEl, actionsEl);

  function apply() {
    const running = Boolean(runningByInstance.get(primaryInstanceId(slot)));
    card.classList.toggle("offline", !running);
    offlineEl.classList.toggle("sky-hidden", running);
    offlineEl.textContent = langZh ? "离线" : "offline";
    actionsEl.classList.toggle("sky-hidden", !running);
    const onState = slot.onState && (statesByInstance.get(slot.onState.instanceId) || {});
    const onEntry = onState ? slotOnEntry(slot, onState) : undefined;
    const on = onEntry ? onEntry[1] : false;
    card.dataset.on = on ? "1" : "0";
    const customIcon = on ? slot.imageOn : slot.imageOff;
    if (customIcon) {
      iconImg.src = customIcon;
      iconImg.style.display = "";
      iconEl.style.display = "none";
    } else {
      iconImg.style.display = "none";
      iconEl.style.display = "";
    }
    valueEl.textContent = onEntry ? (on ? (langZh ? "开" : "ON") : langZh ? "关" : "OFF") : "—";
    if (actionsEl.firstChild) {
      actionsEl.firstChild.textContent = on ? (langZh ? "关闭" : "Turn Off") : langZh ? "开启" : "Turn On";
    }
  }

  return { el: card, apply, cat };
}

function renderSidebar() {
  const cats = CATEGORY_ORDER.filter((c) => (bindingsData[c] || []).length > 0);

  sidebar.innerHTML = "";
  const allBtn = document.createElement("button");
  allBtn.className = "sky-cat" + (activeCat === "__all__" ? " active" : "");
  allBtn.innerHTML = `<span>☰</span><span>${langZh ? "全部" : "All"}</span>`;
  allBtn.addEventListener("click", () => setActiveCategory("__all__"));
  sidebar.appendChild(allBtn);
  cats.forEach((cat) => {
    const btn = document.createElement("button");
    btn.className = "sky-cat" + (activeCat === cat ? " active" : "");
    btn.innerHTML = `<span>${CATEGORY_ICON[cat] || "⚙️"}</span><span>${langZh ? zhCategoryLabel(cat) : CATEGORY_LABEL[cat] || cat}</span>`;
    btn.addEventListener("click", () => setActiveCategory(cat));
    sidebar.appendChild(btn);
  });
  // 3D is treated as just another filterable category, matching QTI's
  // own live pages - only shown once at least one scene has an uploaded
  // model, so an installer who hasn't touched the 3D tab yet sees nothing
  // different here.
  if (panel3d.hasScenes()) {
    const btn = document.createElement("button");
    btn.className = "sky-cat" + (activeCat === "__3d__" ? " active" : "");
    btn.innerHTML = `<span>🏠</span><span>3D</span>`;
    btn.addEventListener("click", () => setActiveCategory("__3d__"));
    sidebar.appendChild(btn);
  }
}
const ZH_CATEGORY_LABEL = { light: "灯光", switch: "开关", security: "安防", climate: "温控", media: "媒体", sensor: "传感器", generic: "通用" };
function zhCategoryLabel(cat) {
  return ZH_CATEGORY_LABEL[cat] || cat;
}

function setActiveCategory(cat) {
  activeCat = cat;
  renderSidebar();
  applyCategoryVisibility();
}
function applyCategoryVisibility() {
  const is3D = activeCat === "__3d__";
  grid.classList.toggle("sky-hidden", is3D);
  live3dPanelEl.classList.toggle("sky-hidden", !is3D);
  if (is3D) {
    panel3d.show();
    return;
  }
  cardEls.forEach(({ el, cat }) => {
    el.classList.toggle("sky-hidden", activeCat !== "__all__" && cat !== activeCat);
  });
  grid.querySelector(".empty")?.remove();
  if (![...cardEls.values()].some(({ cat }) => activeCat === "__all__" || cat === activeCat)) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = langZh ? "没有可显示的实例。" : "No instances to show.";
    grid.appendChild(p);
  }
}

// Iterates bindings.json's slots, not driver instances directly - one
// hub-style instance can back many slots (see roles.js). State/running
// is fetched once per unique instance (not once per slot) to avoid
// redundant requests when several slots share one hub - manifests aren't
// needed here at all anymore, since a slot's own onFn/offFn/levelFn/
// onState/levelState are already fully explicit (instance+action or
// instance+state id), nothing left to resolve via a manifest lookup.
async function refresh() {
  const list = await listInstances();
  await Promise.all(
    list.map(async (summary) => {
      runningByInstance.set(summary.id, summary.running);
      statesByInstance.set(summary.id, await getState(summary.id));
    })
  );

  const seen = new Set();
  for (const cat of CATEGORY_ORDER) {
    for (const slot of bindingsData[cat] || []) {
      if (!(slot.onFn || slot.offFn || slot.levelFn)) continue; // unconfigured - nothing to show
      seen.add(slot.id);
      if (!cardEls.has(slot.id)) {
        const card = slot.levelFn ? buildRingCard(slot, cat) : buildPlainCard(slot, cat);
        cardEls.set(slot.id, card);
        grid.appendChild(card.el);
      }
      cardEls.get(slot.id).apply();
    }
  }

  // Drop cards for slots removed (or unconfigured/dangling) since the last refresh.
  for (const [id, card] of [...cardEls.entries()]) {
    if (!seen.has(id)) {
      card.el.remove();
      cardEls.delete(id);
    }
  }

  renderSidebar();
  applyCategoryVisibility();
}

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, REFRESH_DEBOUNCE_MS);
}

// ---------------------------------------------------------------------
// Top icon bar: size (grid density), theme (light/dark), sound (mute/tone/
// speak feedback), language (EN/中). Ported in spirit from QTI's own
// live.js top-bar handlers - self-contained, no server round-trip for any
// of these.
// ---------------------------------------------------------------------
const sizeBtn = document.getElementById("sizeBtn");
const SIZE_MODES = ["l", "m", "s"];
const SIZE_LABELS = { l: "L", m: "M", s: "S" };
let sizeMode = localStorage.getItem("oak_live_size");
if (!SIZE_MODES.includes(sizeMode)) sizeMode = "m";
function applySize() {
  sizeBtn.textContent = SIZE_LABELS[sizeMode];
  SIZE_MODES.forEach((m) => grid.classList.toggle("size-" + m, m === sizeMode));
}
sizeBtn.addEventListener("click", () => {
  sizeMode = SIZE_MODES[(SIZE_MODES.indexOf(sizeMode) + 1) % 3];
  localStorage.setItem("oak_live_size", sizeMode);
  applySize();
});
applySize();

const themeBtn = document.getElementById("themeBtn");
function systemPrefersDark() {
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
}
let theme = localStorage.getItem("oak_live_theme") || (systemPrefersDark() ? "dark" : "light");
function applyTheme() {
  document.documentElement.dataset.theme = theme;
  themeBtn.textContent = theme === "dark" ? "🌙" : "☀️";
}
themeBtn.addEventListener("click", () => {
  theme = theme === "dark" ? "light" : "dark";
  localStorage.setItem("oak_live_theme", theme);
  applyTheme();
});
applyTheme();

const soundBtn = document.getElementById("soundBtn");
const SOUND_ICONS = ["🔇", "🎵", "🗣️"];
let soundMode = parseInt(localStorage.getItem("oak_live_sound"), 10);
if (isNaN(soundMode)) soundMode = 1;
function applySound() {
  soundBtn.textContent = SOUND_ICONS[soundMode];
}
soundBtn.addEventListener("click", () => {
  soundMode = (soundMode + 1) % 3;
  localStorage.setItem("oak_live_sound", soundMode);
  applySound();
});
applySound();

// Same "prime a persistent AudioContext during a real tap" fix as QTI's
// own tone()/speak() - a fresh AudioContext created outside a genuine user
// gesture starts suspended on mobile and never actually produces sound.
let audioCtx = null;
function tone(freq, dur, delay, vol) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    const start = audioCtx.currentTime + (delay || 0);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(vol || 0.15, start + dur * 0.1);
    gain.gain.linearRampToValueAtTime(0, start + dur);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  } catch (e) {
    /* Web Audio unsupported/blocked - just skip the tone */
  }
}
function speak(text) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = langZh ? "zh-CN" : "en-US";
  u.rate = 0.9;
  window.speechSynthesis.speak(u);
}
function feedbackToggle(label, on) {
  if (soundMode === 0) return;
  if (on === undefined) {
    tone(600, 0.06);
  } else if (on) {
    tone(523, 0.08);
    tone(784, 0.1, 0.08);
  } else {
    tone(659, 0.08);
    tone(392, 0.1, 0.08);
  }
  if (soundMode === 2) speak(label + (on !== undefined ? " " + (on ? (langZh ? "开" : "On") : langZh ? "关" : "Off") : ""));
}

const langBtn = document.getElementById("langBtn");
let langZh = (navigator.language || "").toLowerCase().startsWith("zh");
function applyLang() {
  langBtn.textContent = langZh ? "中" : "EN";
  updateConnLabel();
}
langBtn.addEventListener("click", () => {
  langZh = !langZh;
  applyLang();
  refresh();
  comm.refreshLangText();
  if (SpeechRecognitionCtor) cmdBtn.title = langZh ? "语音指令" : "Voice command";
});

// ---------------------------------------------------------------------
// Voice command - cmdBtn IS the mic button (no popup, no text-input
// fallback - voice-only by design, ported from QTI's own cmdBtn/
// executeCommand). Adapted for Oak's generic action model: QTI matches
// against hardcoded light/media binding shapes (onFn/offFn/volumeFn/
// levelFn); Oak instead finds the named instance, then finds its best-
// matching action by toggle-pair (on/off keywords) or by scoring each
// action's own label against words in the spoken command - since Oak
// actions are driver-defined and arbitrary (armStay/disarm/sendKeys, not
// just on/off), a fixed keyword set the way QTI's has for lights/media
// doesn't generalize the same way here.
// ---------------------------------------------------------------------
const cmdBtn = document.getElementById("cmdBtn");
const cmdFeedback = document.getElementById("cmdFeedback");
const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null;
let recognizing = false;

if (!SpeechRecognitionCtor) {
  cmdBtn.disabled = true;
  cmdBtn.title = "Speech recognition isn't supported in this browser";
}

function setMicUI(micState) {
  recognizing = micState === "listening";
  cmdBtn.classList.toggle("listening", recognizing);
}

let speechUnlocked = false;
function unlockSpeech() {
  if (speechUnlocked) return;
  speechUnlocked = true;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch (e) {}
  if (!("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(" ");
  u.volume = 0;
  window.speechSynthesis.speak(u);
}

cmdBtn.addEventListener("click", () => {
  if (!SpeechRecognitionCtor) return;
  unlockSpeech();
  if (recognizing) {
    recognizer && recognizer.stop();
    return;
  }
  recognizer = new SpeechRecognitionCtor();
  recognizer.lang = langZh ? "zh-CN" : "en-US";
  recognizer.interimResults = false;
  recognizer.maxAlternatives = 1;
  recognizer.onstart = () => setMicUI("listening");
  recognizer.onerror = () => setMicUI("idle");
  recognizer.onend = () => setMicUI("idle");
  recognizer.onresult = (ev) => executeCommand(ev.results[0][0].transcript);
  recognizer.start();
});

// Matches a voice command against slot NAMES ("kitchen", "living room"),
// not driver instance names - this is what makes "turn on kitchen light"
// resolve to the right zone on a shared hub instance instead of only ever
// being able to name the hub itself. Falls back to "the only slot that
// exists" when nothing named matches, same single-device convenience the
// old instance-based version had.
function findNamedSlot(cmdLower, cmdRaw) {
  const all = CATEGORY_ORDER.flatMap((cat) => (bindingsData[cat] || []).map((slot) => ({ slot, cat })));
  const named = all.filter(({ slot }) => slot.name && (cmdRaw.includes(slot.name) || cmdLower.includes(slot.name.toLowerCase())));
  if (named.length) return named.sort((a, b) => b.slot.name.length - a.slot.name.length)[0];
  return all.length === 1 ? all[0] : null;
}

async function executeCommand(raw) {
  const cmd = (raw || "").trim();
  if (!cmd) return;
  const lower = cmd.toLowerCase();
  const wantsOff = /关闭|关掉|turn off|switch off|\boff\b/.test(lower) || (cmd.includes("关") && !cmd.includes("开"));
  const wantsOn = !wantsOff && (/打开|开启|turn on|switch on|\bon\b/.test(lower) || cmd.includes("开"));

  const found = findNamedSlot(lower, cmd);
  let feedback = langZh ? "无法识别指令，或没有匹配到对应的设备名称" : "not understood, or no matching device name in that command";
  let acted = false;

  if (found) {
    const { slot } = found;
    const fn = wantsOff ? slot.offFn : wantsOn ? slot.onFn : slot.onFn || slot.offFn;
    if (fn) {
      try {
        await callFn(fn, slot);
        feedback = langZh ? slot.name + " " + (wantsOff ? "关闭" : "打开") : (wantsOff ? "Turned off " : "Turned on ") + slot.name;
        acted = true;
      } catch (e) {
        feedback = langZh ? "操作失败：" + e.message : "Action failed: " + e.message;
      }
    }
  }

  cmdFeedback.textContent = `"${cmd}" → ${feedback}`;
  cmdFeedback.classList.add("show");
  clearTimeout(cmdFeedback.__hideTimer);
  cmdFeedback.__hideTimer = setTimeout(() => cmdFeedback.classList.remove("show"), 4000);
  if (acted) {
    speak(feedback);
    scheduleRefresh();
  }
}

const connEl = document.getElementById("conn");
const connLabel = document.getElementById("connlabel");
function updateConnLabel() {
  const connected = connEl.classList.contains("connected");
  connLabel.textContent = connected ? (langZh ? "已连接" : "connected") : langZh ? "重新连接…" : "connecting";
}
cmdBtn.title = SpeechRecognitionCtor ? (langZh ? "语音指令" : "Voice command") : "Speech recognition isn't supported in this browser";
applyLang();

const WS = connectWS();
const comm = createCommPanel({ WS, langZh: () => langZh });

async function bootstrapAndRefresh() {
  bindingsData = await getBindings();
  refresh();
}
bootstrapAndRefresh();
WS.onPush((msg) => {
  // A bindings save (from an admin editing Dashboard in another tab)
  // arrives with the new data already in the message - use it directly
  // instead of a redundant GET before the same refresh() we're about to
  // schedule anyway.
  if (msg.type === "bindings" && msg.bindings) bindingsData = msg.bindings;
  scheduleRefresh();
});
WS.onStatus((connected) => {
  connEl.classList.toggle("connected", connected);
  updateConnLabel();
});
comm.init();
setInterval(refresh, FALLBACK_POLL_MS);
