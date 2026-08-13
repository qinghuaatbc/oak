// Live view: sidebar-by-driver-type + frosted-glass sky-card grid, ported
// from QTI's own live.js/live.html structure (sky-wrap/sky-sidebar/
// sky-card) - simplified to plain icon+label+buttons cards since Oak has
// no dimmable/level-type state yet to justify QTI's ring-dial widget.
import { listInstances, getManifest, getState, callAction } from "./api.js";
import { connectWS } from "./live-socket.js";
import { createCommPanel } from "./comm.js";

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

function buildCard(instanceId, manifest, state, running) {
  const icon = DRIVER_ICONS[manifest.id] || DRIVER_ICON_FALLBACK;
  const togglePair = findTogglePair(manifest);
  const boolEntry = Object.entries(state).find(([, v]) => typeof v === "boolean");
  const useToggle = Boolean(togglePair && boolEntry);
  const on = boolEntry ? boolEntry[1] : false;
  const zh = langZh;

  const card = document.createElement("div");
  card.className = "sky-card" + (running ? "" : " offline");
  card.dataset.category = manifest.id;
  card.dataset.on = on ? "1" : "0";

  const iconEl = document.createElement("div");
  iconEl.className = "sky-icon";
  iconEl.textContent = icon;

  const valueEl = document.createElement("div");
  valueEl.className = "sky-value";
  // A stopped instance's state is a last-known snapshot from before it was
  // stopped (see server.js's lastState) - still shown, but the "offline"
  // badge below makes clear it's not live right now.
  valueEl.textContent = Object.keys(state).length
    ? Object.entries(state)
        .map(([k, v]) => (typeof v === "boolean" ? (v ? (zh ? "开" : "ON") : zh ? "关" : "OFF") : String(v)))
        .join(" · ")
    : "—";

  const labelEl = document.createElement("div");
  labelEl.className = "sky-label";
  labelEl.textContent = manifest.displayName;

  if (!running) {
    const offlineEl = document.createElement("div");
    offlineEl.className = "sky-offline-badge";
    offlineEl.textContent = zh ? "离线" : "offline";
    card.append(iconEl, valueEl, labelEl, offlineEl);
    return card;
  }

  const actionsEl = document.createElement("div");
  actionsEl.className = "sky-actions";
  manifest.actions.forEach((a) => {
    if (useToggle && a.id === togglePair[1]) return; // toggle pair -> one tap target, not two buttons
    const btn = document.createElement("button");
    btn.className = "sky-action-btn" + (useToggle && a.id === togglePair[0] ? " primary" : "");
    btn.textContent = useToggle && a.id === togglePair[0] ? (on ? (zh ? "关闭" : "Turn Off") : zh ? "开启" : "Turn On") : a.label;
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const actionId = useToggle && a.id === togglePair[0] ? (on ? togglePair[1] : togglePair[0]) : a.id;
      try {
        await callAction(instanceId, actionId, {});
      } catch (err) {
        console.error("action failed", err);
      }
      feedbackToggle(a.label, useToggle ? !on : undefined);
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
  allBtn.innerHTML = `<span>☰</span><span>${langZh ? "全部" : "All"}</span>`;
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
      return { instanceId: summary.id, manifest, state, running: summary.running };
    })
  );

  renderSidebar(new Set(cards.map((c) => c.manifest.id)));

  const visible = activeCat === "__all__" ? cards : cards.filter((c) => c.manifest.id === activeCat);
  grid.innerHTML = "";
  if (!visible.length) {
    grid.innerHTML = `<p class="empty">${langZh ? "没有可显示的实例。" : "No instances to show."}</p>`;
    return;
  }
  visible.forEach(({ instanceId, manifest, state, running }) => grid.appendChild(buildCard(instanceId, manifest, state, running)));
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

// Same "prime on a real synchronous gesture" fix as QTI's own unlockSpeech -
// mobile browsers only let speechSynthesis produce audio if activated by a
// genuine user gesture, and the real announcement fires from
// SpeechRecognition's async onresult callback, well after that gesture
// window has closed.
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

// Longest-name-wins, same as QTI's own findNamedSlot - "kitchen main relay"
// should prefer a slot literally named that over a shorter partial match.
// Falls back to the only instance if nothing named is mentioned and
// exactly one instance exists.
function findNamedInstance(cmdLower, cmdRaw) {
  const named = instanceIds
    .map((id) => ({ id, manifest: manifests.get(id) }))
    .filter(({ manifest }) => manifest.displayName && (cmdRaw.includes(manifest.displayName) || cmdLower.includes(manifest.displayName.toLowerCase())));
  if (named.length) return named.sort((a, b) => b.manifest.displayName.length - a.manifest.displayName.length)[0];
  return instanceIds.length === 1 ? { id: instanceIds[0], manifest: manifests.get(instanceIds[0]) } : null;
}

function findMatchingAction(manifest, cmdLower, wantsOn, wantsOff) {
  const togglePair = findTogglePair(manifest);
  if (togglePair) {
    if (wantsOn) return manifest.actions.find((a) => a.id === togglePair[0]);
    if (wantsOff) return manifest.actions.find((a) => a.id === togglePair[1]);
  }
  // Fallback: score each action's own label against words in the command -
  // covers DSC-style actions ("Arm Stay", "Disarm") that aren't a simple
  // on/off pair at all.
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
