// Live view: category sidebar + frosted-glass sky-card grid, ported from
// QTI's own live.js/live.html structure (sky-wrap/sky-sidebar/sky-card,
// ring-dial geometry). Cards are built once per instance and updated in
// place afterward (cardEls Map), not rebuilt from scratch on every
// refresh - QTI's own shared.js has a direct comment on why: a full
// rebuild mid-drag is exactly the bug that bit its admin tile grid once
// already, and the ring widget below needs real dragging to work at all.
import { listInstances, getManifest, getState, callAction } from "./api.js";
import { connectWS } from "./live-socket.js";
import { createCommPanel } from "./comm.js";
import { CATEGORY_ICON, CATEGORY_LABEL, CATEGORY_ORDER, effectiveCategories, getOnOffPair, getLevelAction, getOnState, getLevelState } from "./roles.js";

const FALLBACK_POLL_MS = 10000;
const REFRESH_DEBOUNCE_MS = 150;

const grid = document.getElementById("skyGrid");
const sidebar = document.getElementById("skySidebar");
let manifests = new Map(); // id -> manifest
let instanceIds = [];
let categoriesByInstance = new Map(); // id -> string[]
let cardEls = new Map(); // id -> {el, apply(state, running)}
let activeCat = "__all__";

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

// A ring-dial card for a light/media-category instance with a role-tagged
// "level" action - tap toggles on/off (via the on/off role pair, if any),
// drag sets level. hasDial=false (level role present but no on/off pair)
// still shows the ring, drag-only, no tap-toggle.
function buildRingCard(instanceId, manifest, categories) {
  const onOffPair = getOnOffPair(manifest);
  const levelAction = getLevelAction(manifest);
  const hasDial = Boolean(levelAction);

  const box = document.createElement("div");
  box.className = "sky-card";
  box.dataset.categories = JSON.stringify(categories);
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
  bulb.textContent = categories.includes("media") ? "🔊" : "💡";
  svg.append(track, val, thumb, bulb);
  box.appendChild(svg);

  const valueEl = document.createElement("div");
  valueEl.className = "sky-value";
  const labelEl = document.createElement("div");
  labelEl.className = "sky-label";
  labelEl.textContent = manifest.displayName;
  const offlineEl = document.createElement("div");
  offlineEl.className = "sky-offline-badge sky-hidden";
  box.append(valueEl, labelEl, offlineEl);

  function applyVisual(value, on) {
    val.setAttribute("d", ringArc(RING_START, (value / 100) * RING_SPAN, RING_R_ARC));
    const [tx, ty] = ringPolar(RING_START + (value / 100) * RING_SPAN, RING_R_ARC);
    thumb.setAttribute("cx", tx.toFixed(2));
    thumb.setAttribute("cy", ty.toFixed(2));
    bulb.style.opacity = on ? Math.max(0.35, value / 100) : 0.25;
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
  let currentOn = false;

  svg.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    dragging = true;
    didDrag = false;
    downX = ev.clientX;
    downY = ev.clientY;
    svg.setPointerCapture(ev.pointerId);
  });
  svg.addEventListener("pointermove", (ev) => {
    if (!dragging || !hasDial) return;
    if (!didDrag) {
      if (Math.hypot(ev.clientX - downX, ev.clientY - downY) < DRAG_THRESHOLD_PX) return;
      didDrag = true;
    }
    const v = Math.round(ringProgressFromEvent(svg, ev) * 100);
    applyVisual(v, true);
    pendingValue = v;
    if (!throttleTimer) {
      throttleTimer = setTimeout(() => {
        throttleTimer = null;
        callAction(instanceId, levelAction.id, { [levelAction.params && levelAction.params[0] ? levelAction.params[0].key : "level"]: pendingValue }).catch((e) =>
          console.error("level action failed", e)
        );
      }, 200);
    }
  });
  svg.addEventListener("pointerup", (ev) => {
    if (!dragging) return;
    dragging = false;
    if (!hasDial || !didDrag) {
      if (!onOffPair) return;
      const turningOn = box.dataset.on !== "1";
      callAction(instanceId, turningOn ? onOffPair[0] : onOffPair[1], {}).catch((e) => console.error("action failed", e));
      feedbackToggle(manifest.displayName, turningOn);
      scheduleRefresh();
      return;
    }
    const v = Math.round(ringProgressFromEvent(svg, ev) * 100);
    applyVisual(v, true);
    const paramKey = levelAction.params && levelAction.params[0] ? levelAction.params[0].key : "level";
    callAction(instanceId, levelAction.id, { [paramKey]: v }).catch((e) => console.error("level action failed", e));
  });

  function apply(state, running) {
    box.classList.toggle("offline", !running);
    offlineEl.classList.toggle("sky-hidden", running);
    offlineEl.textContent = langZh ? "离线" : "offline";
    const onEntry = getOnState(manifest, state);
    const levelValue = getLevelState(manifest, state);
    currentOn = onEntry ? onEntry[1] : levelValue > 0;
    applyVisual(levelValue !== undefined ? levelValue : currentOn ? 100 : 0, currentOn);
  }

  return { el: box, apply, categories };
}

// Plain card (icon + value text + action buttons) for everything without
// a level role - switches, security, sensors, and any driver action set
// too varied for a single ring to represent.
function buildPlainCard(instanceId, manifest, categories) {
  const icon = CATEGORY_ICON[categories[0]] || "⚙️";
  const onOffPair = getOnOffPair(manifest);

  const card = document.createElement("div");
  card.className = "sky-card";
  card.dataset.categories = JSON.stringify(categories);
  card.dataset.on = "0";

  const iconEl = document.createElement("div");
  iconEl.className = "sky-icon";
  iconEl.textContent = icon;
  const valueEl = document.createElement("div");
  valueEl.className = "sky-value";
  const labelEl = document.createElement("div");
  labelEl.className = "sky-label";
  labelEl.textContent = manifest.displayName;
  const offlineEl = document.createElement("div");
  offlineEl.className = "sky-offline-badge sky-hidden";
  const actionsEl = document.createElement("div");
  actionsEl.className = "sky-actions";

  manifest.actions.forEach((a) => {
    if (onOffPair && a.id === onOffPair[1]) return; // toggle pair -> one tap target, not two buttons
    const btn = document.createElement("button");
    btn.className = "sky-action-btn" + (onOffPair && a.id === onOffPair[0] ? " primary" : "");
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const isToggle = onOffPair && a.id === onOffPair[0];
      const on = card.dataset.on === "1";
      const actionId = isToggle ? (on ? onOffPair[1] : onOffPair[0]) : a.id;
      try {
        await callAction(instanceId, actionId, {});
      } catch (err) {
        console.error("action failed", err);
      }
      feedbackToggle(a.label, isToggle ? !on : undefined);
      scheduleRefresh();
    });
    actionsEl.appendChild(btn);
  });

  card.append(iconEl, valueEl, labelEl, offlineEl, actionsEl);

  function apply(state, running) {
    card.classList.toggle("offline", !running);
    offlineEl.classList.toggle("sky-hidden", running);
    offlineEl.textContent = langZh ? "离线" : "offline";
    actionsEl.classList.toggle("sky-hidden", !running);
    const onEntry = getOnState(manifest, state);
    const on = onEntry ? onEntry[1] : false;
    card.dataset.on = on ? "1" : "0";
    valueEl.textContent = Object.keys(state).length
      ? Object.entries(state)
          .map(([, v]) => (typeof v === "boolean" ? (v ? (langZh ? "开" : "ON") : langZh ? "关" : "OFF") : String(v)))
          .join(" · ")
      : "—";
    // Relabel the toggle button (On/Off text follows current state) and
    // every plain button's own label - simplest correct approach given
    // button count/order is fixed once at build time.
    let bi = 0;
    manifest.actions.forEach((a) => {
      if (onOffPair && a.id === onOffPair[1]) return;
      const btn = actionsEl.children[bi++];
      if (!btn) return;
      btn.textContent = onOffPair && a.id === onOffPair[0] ? (on ? (langZh ? "关闭" : "Turn Off") : langZh ? "开启" : "Turn On") : a.label;
    });
  }

  return { el: card, apply, categories };
}

function renderSidebar() {
  const present = new Set();
  instanceIds.forEach((id) => (categoriesByInstance.get(id) || []).forEach((c) => present.add(c)));
  const cats = CATEGORY_ORDER.filter((c) => present.has(c));

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
  cardEls.forEach(({ el, categories }) => {
    el.classList.toggle("sky-hidden", activeCat !== "__all__" && !categories.includes(activeCat));
  });
  grid.querySelector(".empty")?.remove();
  if (![...cardEls.values()].some(({ categories }) => activeCat === "__all__" || categories.includes(activeCat))) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = langZh ? "没有可显示的实例。" : "No instances to show.";
    grid.appendChild(p);
  }
}

async function refresh() {
  const list = await listInstances();
  instanceIds = list.map((s) => s.id);
  const seen = new Set();

  for (const summary of list) {
    seen.add(summary.id);
    if (!manifests.has(summary.id)) manifests.set(summary.id, await getManifest(summary.id));
    const manifest = manifests.get(summary.id);
    const categories = effectiveCategories(manifest, summary.categoryOverride);
    categoriesByInstance.set(summary.id, categories);
    const state = await getState(summary.id);

    if (!cardEls.has(summary.id)) {
      const useRing = categories.some((c) => c === "light" || c === "media") && Boolean(getLevelAction(manifest));
      const card = useRing ? buildRingCard(summary.id, manifest, categories) : buildPlainCard(summary.id, manifest, categories);
      cardEls.set(summary.id, card);
      grid.appendChild(card.el);
    }
    cardEls.get(summary.id).apply(state, summary.running);
  }

  // Drop cards for instances removed since the last refresh.
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

function findNamedInstance(cmdLower, cmdRaw) {
  const named = instanceIds
    .map((id) => ({ id, manifest: manifests.get(id) }))
    .filter(({ manifest }) => manifest.displayName && (cmdRaw.includes(manifest.displayName) || cmdLower.includes(manifest.displayName.toLowerCase())));
  if (named.length) return named.sort((a, b) => b.manifest.displayName.length - a.manifest.displayName.length)[0];
  return instanceIds.length === 1 ? { id: instanceIds[0], manifest: manifests.get(instanceIds[0]) } : null;
}

function findMatchingAction(manifest, cmdLower, wantsOn, wantsOff) {
  const onOffPair = getOnOffPair(manifest);
  if (onOffPair) {
    if (wantsOn) return manifest.actions.find((a) => a.id === onOffPair[0]);
    if (wantsOff) return manifest.actions.find((a) => a.id === onOffPair[1]);
  }
  let best = null;
  let bestScore = 0;
  manifest.actions.forEach((a) => {
    const words = a.label.toLowerCase().split(/\s+/);
    const score = words.filter((w) => w.length > 1 && cmdLower.includes(w)).length;
    if (score > bestScore) {
      bestScore = score;
      best = a;
    }
  });
  return best;
}

async function executeCommand(raw) {
  const cmd = (raw || "").trim();
  if (!cmd) return;
  const lower = cmd.toLowerCase();
  const wantsOff = /关闭|关掉|turn off|switch off|\boff\b/.test(lower) || (cmd.includes("关") && !cmd.includes("开"));
  const wantsOn = !wantsOff && (/打开|开启|turn on|switch on|\bon\b/.test(lower) || cmd.includes("开"));

  const found = findNamedInstance(lower, cmd);
  let feedback = langZh ? "无法识别指令，或没有匹配到对应的设备名称" : "not understood, or no matching device name in that command";
  let acted = false;

  if (found) {
    const action = findMatchingAction(found.manifest, lower, wantsOn, wantsOff);
    if (action) {
      try {
        await callAction(found.id, action.id, {});
        feedback = langZh ? found.manifest.displayName + " " + action.label : action.label + " " + found.manifest.displayName;
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

refresh();
WS.onPush(() => scheduleRefresh());
WS.onStatus((connected) => {
  connEl.classList.toggle("connected", connected);
  updateConnLabel();
});
comm.init();
setInterval(refresh, FALLBACK_POLL_MS);
