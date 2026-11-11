"use strict";
// Dashboard bindings (slots per category, 3D scenes, Layout pages): loading,
// saving, validating what the browser sends, and auto-generating slots
// from the instances' manifests - plus the /api/bindings routes.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { instances } = require("./instances");
const { broadcast } = require("./broadcast");
const { sendJson, readJsonBody } = require("./http-util");

// --- Dashboard bindings: QTI's own model, ported directly rather than
// Oak's earlier (now removed) 1-card-per-instance approach. A binding
// "slot" is NOT the same thing as a driver instance - one hub-style
// instance (e.g. a multi-zone controller) can back many slots, each
// naming a specific zone/device and picking which of that instance's
// exported actions is its on/off/level function, with fixedArgs merged
// into every call (e.g. {zone:"kitchen"}) - this is what lets "kitchen
// light" and "living room light" both be slots against the SAME instance.
// Grouped by category so the Dashboard/Live UI can render one section per
// category the same way QTI's admin does (Lights, Switches, ...).
const BINDINGS_PATH = process.env.OAK_BINDINGS || path.join(__dirname, "bindings.json");
const BINDING_CATEGORIES = ["light", "switch", "climate", "security", "media", "sensor", "generic"];
// 3D mesh-binding animation vocabulary - matches QTI's own create3DViewer
// exactly (QTI is this project's own prior work, not RTI's, so this is
// reusing an already-proven design rather than approximating one): a mesh
// either just highlights on click ("light"/glow), breathes continuously
// while on ("pulse", for speakers/media), or moves along one axis
// ("rotate"/"slide"/"roller" - swinging door, sliding door/window,
// roller shutter). Only the axis types need an axis+direction.
const ANIM_TYPES = ["", "light", "pulse", "rotate", "slide", "roller"];
const AXIS_ANIM_TYPES = new Set(["rotate", "slide", "roller"]);
function bindingsDefaults() {
  const obj = {};
  for (const c of BINDING_CATEGORIES) obj[c] = [];
  obj.customCategories = [];
  obj.glbs = [];
  obj.pages = [];
  return obj;
}
// All valid slot-category ids for a given bindings object: the fixed
// built-ins plus whatever custom categories that bindings object has
// defined. Threaded explicitly into the sanitizers below (rather than read
// off the module-level `bindings` global) since sanitizeBindings() is
// rebuilding a whole bindings object from scratch, including
// customCategories itself, in one pass - a custom category slot array or
// mesh binding must validate against the customCategories that same raw
// payload just defined, not the previous one still sitting in memory.
function allCategoryIds(customCategories) {
  return [...BINDING_CATEGORIES, ...(Array.isArray(customCategories) ? customCategories.map((c) => c.id) : [])];
}
function loadBindings() {
  if (!fs.existsSync(BINDINGS_PATH)) return bindingsDefaults();
  try {
    const raw = JSON.parse(fs.readFileSync(BINDINGS_PATH, "utf8"));
    const out = bindingsDefaults();
    if (Array.isArray(raw.customCategories)) out.customCategories = raw.customCategories.map(sanitizeCustomCategory).filter(Boolean);
    for (const c of allCategoryIds(out.customCategories)) out[c] = Array.isArray(raw[c]) ? raw[c] : [];
    if (Array.isArray(raw.glbs)) out.glbs = raw.glbs;
    if (Array.isArray(raw.pages)) out.pages = raw.pages;
    return out;
  } catch (e) {
    console.error(`Failed to read ${BINDINGS_PATH}:`, e.message);
    return bindingsDefaults();
  }
}
let bindings = loadBindings();
function saveBindings() {
  fs.writeFileSync(BINDINGS_PATH, JSON.stringify(bindings, null, 2));
}

// Sanitizes a client-submitted bindings object the same defensive,
// field-by-field way QTI's own saveBindings handler does (server.js:
// 1802-1821 in QTI) rather than trusting the body shape wholesale.
// A function ref is either {kind:"action", instanceId, actionId} or
// {kind:"macro", macroId} - On/Off get both kinds (a macro has no live
// value, but on/off don't need one), Level is action-only (pass
// allowMacro=false) since a macro can't receive the live drag value a
// ring widget sends.
function sanitizeFn(f, allowMacro) {
  if (!f || typeof f !== "object") return undefined;
  if (allowMacro && f.kind === "macro") {
    return typeof f.macroId === "string" && f.macroId ? { kind: "macro", macroId: f.macroId } : undefined;
  }
  if (typeof f.instanceId === "string" && typeof f.actionId === "string") {
    return { kind: "action", instanceId: f.instanceId, actionId: f.actionId };
  }
  return undefined;
}
function sanitizeStateRef(s) {
  if (!s || typeof s !== "object") return undefined;
  return typeof s.instanceId === "string" && typeof s.stateId === "string" ? { instanceId: s.instanceId, stateId: s.stateId } : undefined;
}
function sanitizeSlot(s) {
  if (!s || typeof s !== "object") return null;
  return {
    id: typeof s.id === "string" && s.id ? s.id : crypto.randomBytes(4).toString("hex"),
    name: typeof s.name === "string" ? s.name.slice(0, 60) : "Untitled",
    onFn: sanitizeFn(s.onFn, true),
    offFn: sanitizeFn(s.offFn, true),
    levelFn: sanitizeFn(s.levelFn, false),
    onState: sanitizeStateRef(s.onState),
    levelState: sanitizeStateRef(s.levelState),
    fixedArgs: s.fixedArgs && typeof s.fixedArgs === "object" ? s.fixedArgs : {},
    stateSuffix: typeof s.stateSuffix === "string" && s.stateSuffix ? s.stateSuffix : undefined,
    // Optional custom icon pair (uploaded via the same /api/image-upload
    // endpoint the Layout page's background image uses) - an on/off PAIR,
    // not a single image, on purpose: a single static image would erase
    // the on/off distinction the card exists to show in the first place.
    imageOn: typeof s.imageOn === "string" && s.imageOn ? s.imageOn : undefined,
    imageOff: typeof s.imageOff === "string" && s.imageOff ? s.imageOff : undefined,
  };
}
// A mesh binding is a POINTER into bindings[cat], not a copy of a slot -
// {cat:"light", id:"7c61707f"} looks up the same slot the Dashboard tab
// already renders, so a 3D scene's device wiring (on/off/level functions,
// state refs, fixedArgs) has exactly one source of truth. This mirrors
// QTI's own {kind, id} mesh-binding shape (server.js's meshBindings), just
// with Oak's actual category vocabulary in place of QTI's fixed
// lights/media/doors/security set.
function sanitizeMeshBinding(m, catIds) {
  if (!m || typeof m !== "object") return undefined;
  if (!catIds.includes(m.cat) || typeof m.id !== "string" || !m.id) return undefined;
  const out = { cat: m.cat, id: m.id, animType: ANIM_TYPES.includes(m.animType) ? m.animType : "" };
  if (AXIS_ANIM_TYPES.has(out.animType)) {
    out.axis = ["x", "y", "z"].includes(m.axis) ? m.axis : "x";
    out.dir = m.dir === -1 ? -1 : 1;
  }
  return out;
}
function sanitizeGlbScene(s, catIds) {
  if (!s || typeof s !== "object") return null;
  const meshBindings = {};
  if (s.meshBindings && typeof s.meshBindings === "object") {
    for (const [meshName, mb] of Object.entries(s.meshBindings)) {
      const sm = sanitizeMeshBinding(mb, catIds);
      if (sm) meshBindings[meshName] = sm;
    }
  }
  return {
    id: typeof s.id === "string" && s.id ? s.id : crypto.randomBytes(4).toString("hex"),
    name: typeof s.name === "string" && s.name ? s.name.slice(0, 60) : "Untitled",
    url: typeof s.url === "string" && s.url ? s.url : null,
    meshBindings,
  };
}
// Layout: a custom drag-drop dashboard page, ported from QTI's own
// live-custom.js/app.js feature (QTI is this project's own prior work,
// not RTI's - reusing an already-proven design). A page is
// {id, name, background, widgets[]} on a 12-column grid (x/y/w/h are grid
// cell indices, not pixels, so the same coordinates place a widget
// identically in the admin editor and the live renderer regardless of
// either one's actual pixel row height). Unlike QTI - which stores a
// separate lights/media/doors/keypads/security/imageButtons/cameras/
// macros array per binding category and needs one widget TYPE per array -
// Oak's Dashboard is already unified around one generic "slot" shape per
// category (see BINDING_CATEGORIES/sanitizeSlot above), so a single
// "slot" widget type with a {cat, slotId} pointer covers every device
// category at once; only camera and macro (Oak's other two non-category
// top-level entities) get their own widget types.
const LAYOUT_WIDGET_TYPES = new Set(["slot", "camera", "macro", "pageLink", "appUrl", "webObject", "label", "varDisplay"]);
function sanitizeWidget(w, catIds) {
  if (!w || typeof w !== "object" || !LAYOUT_WIDGET_TYPES.has(w.type)) return null;
  const out = {
    id: typeof w.id === "string" && w.id ? w.id : crypto.randomBytes(4).toString("hex"),
    type: w.type,
    x: Math.max(0, Math.min(11, Math.round(Number(w.x)) || 0)),
    y: Math.max(0, Math.round(Number(w.y)) || 0),
    w: Math.max(1, Math.min(12, Math.round(Number(w.w)) || 2)),
    h: Math.max(1, Math.round(Number(w.h)) || 2),
    locked: Boolean(w.locked),
  };
  if (Number.isFinite(Number(w.z))) out.z = Number(w.z);
  if (w.type === "slot") {
    // A pointer into bindings[cat] by slot id, not a copy - same
    // {cat, id}-style reasoning as a 3D mesh binding (see
    // sanitizeMeshBinding above): editing a slot's name/function on the
    // Dashboard tab is automatically reflected on every page it's placed
    // on, with no separate sync step.
    if (!catIds.includes(w.cat) || typeof w.slotId !== "string" || !w.slotId) return null;
    out.cat = w.cat;
    out.slotId = w.slotId;
    if (w.showLevel !== undefined) out.showLevel = Boolean(w.showLevel);
  } else if (w.type === "camera") {
    if (typeof w.cameraId !== "string" || !w.cameraId) return null;
    out.cameraId = w.cameraId;
  } else if (w.type === "macro") {
    if (typeof w.macroId !== "string" || !w.macroId) return null;
    out.macroId = w.macroId;
  } else if (w.type === "pageLink") {
    out.label = typeof w.label === "string" ? w.label.slice(0, 60) : "Link";
    if (typeof w.targetPageId !== "string" || !w.targetPageId) return null;
    out.targetPageId = w.targetPageId;
  } else if (w.type === "appUrl") {
    out.label = typeof w.label === "string" ? w.label.slice(0, 60) : "Link";
    if (typeof w.url !== "string" || !w.url) return null;
    out.url = w.url.slice(0, 500);
    out.openInNewTab = Boolean(w.openInNewTab);
  } else if (w.type === "webObject") {
    out.label = typeof w.label === "string" ? w.label.slice(0, 60) : "Web Object";
    if (typeof w.url !== "string" || !w.url) return null;
    out.url = w.url.slice(0, 500);
  } else if (w.type === "label") {
    out.text = typeof w.text === "string" ? w.text.slice(0, 200) : "";
  } else if (w.type === "varDisplay") {
    out.label = typeof w.label === "string" ? w.label.slice(0, 60) : "Value";
    if (typeof w.instanceId !== "string" || !w.instanceId || typeof w.stateId !== "string" || !w.stateId) return null;
    out.instanceId = w.instanceId;
    out.stateId = w.stateId;
    if (typeof w.stateSuffix === "string" && w.stateSuffix) out.stateSuffix = w.stateSuffix;
  }
  return out;
}
function sanitizeLayoutBackground(bg) {
  if (!bg || typeof bg !== "object") return null;
  // A 3D scene background - {type:"3d", glbId} pointing at bindingsCache.glbs
  // by id, same "pointer, not copy" reasoning as a slot widget's {cat,
  // slotId} (see sanitizeWidget's own comment) or a mesh binding's {cat, id}
  // (sanitizeMeshBinding above) - loosely validated (type-checked, not
  // existence-checked against the real glbs list) to match the precedent
  // already set by pageLink's targetPageId just below, which isn't
  // cross-checked against the real pages list either.
  if (bg.type === "3d") {
    return typeof bg.glbId === "string" && bg.glbId ? { type: "3d", glbId: bg.glbId } : null;
  }
  // The original flat-image shape.
  return typeof bg.url === "string" ? { url: bg.url } : null;
}
function sanitizePage(p, catIds) {
  if (!p || typeof p !== "object") return null;
  const widgets = Array.isArray(p.widgets) ? p.widgets.map((w) => sanitizeWidget(w, catIds)).filter(Boolean) : [];
  return {
    id: typeof p.id === "string" && p.id ? p.id : crypto.randomBytes(4).toString("hex"),
    name: typeof p.name === "string" && p.name ? p.name.slice(0, 60) : "Untitled",
    background: sanitizeLayoutBackground(p.background),
    widgets,
  };
}
// A custom category ({id, label, icon}) extends BINDING_CATEGORIES for
// slot filing purposes only - see roles.js's effectiveCategoryOrder header
// comment for why driver-side role inference stays built-in-only. `id` is
// slugified from the label on creation (client-side, like a driver id) and
// never re-slugified here on edit, since a stable id is what every slot/
// mesh-binding/widget pointing at this category is keyed on - only label/
// icon are editable after creation.
function sanitizeCustomCategory(c) {
  if (!c || typeof c !== "object") return null;
  const id = typeof c.id === "string" && c.id ? c.id.slice(0, 40) : "";
  if (!id || BINDING_CATEGORIES.includes(id)) return null;
  return {
    id,
    label: typeof c.label === "string" && c.label ? c.label.slice(0, 40) : id,
    icon: typeof c.icon === "string" && c.icon ? c.icon.slice(0, 8) : "⭐",
  };
}
function sanitizeBindings(raw) {
  const out = bindingsDefaults();
  if (!raw || typeof raw !== "object") return out;
  // Dedupe by id, keeping the first occurrence, so a submitted duplicate
  // id (shouldn't happen via the UI, but this is the boundary that must
  // hold regardless) can't silently shadow an existing category's slots.
  const seen = new Set();
  out.customCategories = Array.isArray(raw.customCategories)
    ? raw.customCategories
        .map(sanitizeCustomCategory)
        .filter((c) => c && !seen.has(c.id) && seen.add(c.id))
    : [];
  const catIds = allCategoryIds(out.customCategories);
  for (const c of catIds) {
    out[c] = Array.isArray(raw[c]) ? raw[c].map(sanitizeSlot).filter(Boolean) : [];
  }
  out.glbs = Array.isArray(raw.glbs) ? raw.glbs.map((s) => sanitizeGlbScene(s, catIds)).filter(Boolean) : [];
  out.pages = Array.isArray(raw.pages) ? raw.pages.map((p) => sanitizePage(p, catIds)).filter(Boolean) : [];
  return out;
}

// Explicit, opt-in convenience (a button in the UI), not a silent side
// effect of adding an instance - QTI reached the same conclusion for its
// own "binding templates" feature. Idempotent: running it twice in a row
// adds nothing new, since it skips any category where the instance
// already has an un-zoned (fixedArgs-less) default slot.
// Role lookups are scoped per category, not a single manifest-wide find()
// - a hub manifest can have DIFFERENT actions plausibly matching the same
// role in different subsystems (e.g. zone-hub's lightSetLevel is role
// "level" for its light zones, but that must never get picked as the
// climate zone's target-temperature function just because both are role
// "level" scans over the same actions array). Security uses arm/disarm
// instead of on/off; climate has no settled on/off/level role vocabulary
// yet, so its default slot is left with no functions bound at all -
// skipped entirely rather than creating an empty, unusable slot - and the
// admin binds it by hand (exactly what the zone-hub example driver is
// for: proving the manual path works, not just the auto-generated one).
function roleActionsForCategory(manifest, cat) {
  if (cat === "security") {
    return { onAction: manifest.actions.find((a) => a.role === "arm"), offAction: manifest.actions.find((a) => a.role === "disarm"), levelAction: undefined };
  }
  if (cat === "climate" || cat === "sensor") {
    return { onAction: undefined, offAction: undefined, levelAction: undefined };
  }
  return {
    onAction: manifest.actions.find((a) => a.role === "on"),
    offAction: manifest.actions.find((a) => a.role === "off"),
    levelAction: manifest.actions.find((a) => a.role === "level"),
  };
}
// Mirrors roleActionsForCategory's category-scoping for STATES - a blind
// manifest-wide "find the state with role=level" has the exact same
// cross-subsystem collision problem actions have (zone-hub's light.level
// and a hypothetical climate state could both plausibly want role
// "level"), so this stays in lockstep with which category is being
// generated for rather than scanning independently.
function roleStatesForCategory(manifest, cat) {
  if (cat === "security" || cat === "climate" || cat === "sensor") {
    // No settled role vocabulary for a security/climate/sensor readout
    // state yet (arm/disarm doesn't have a simple boolean "on" state the
    // way a light does) - left unbound, same as their actions above; a
    // plain card without a level function never reads levelState anyway.
    return { onState: undefined, levelState: undefined };
  }
  return { onState: manifest.states.find((s) => s.role === "on"), levelState: manifest.states.find((s) => s.role === "level") };
}
// A `perInstance` state (see SPEC.md) is ALWAYS reported suffixed
// ("<stateId>#<instanceKey>"), even for a driver with only one relay/
// zone/partition - http-relay's driver.js calls
// ctx.setState("relay.on", value, "0") unconditionally, there's no bare
// "relay.on" key to fall back to. A default (un-zoned) auto-generated
// slot needs SOME suffix to ever read that state back, so this peeks at
// the instance's actual live state (only possible while it's running) to
// find one - if there's exactly one distinct suffix in use for that
// state id, that's an unambiguous, safe guess; if there are several
// (a real multi-zone device already reporting more than one), guessing
// would silently pick the wrong one, so this deliberately backs off and
// leaves stateSuffix unset - same "don't guess when it's genuinely
// ambiguous" call roleActionsForCategory makes for climate.
function detectSingleSuffix(entry, stateId) {
  if (!stateId || !entry.running || !entry.driverInstance) return undefined;
  const state = entry.driverInstance.getAllState();
  if (stateId in state) return undefined; // bare key exists - no suffix needed at all
  const prefix = `${stateId}#`;
  const suffixes = new Set();
  for (const key of Object.keys(state)) {
    if (key.startsWith(prefix)) suffixes.add(key.slice(prefix.length));
  }
  return suffixes.size === 1 ? [...suffixes][0] : undefined;
}
function autoGenerateBindings() {
  let added = 0;
  for (const [id, entry] of instances) {
    const manifest = entry.manifest;
    const cats = Array.isArray(manifest.category) ? manifest.category : [manifest.category || "generic"];
    for (const cat of cats) {
      if (!BINDING_CATEGORIES.includes(cat)) continue;
      // "Already has a default for this instance" means an un-zoned slot
      // whose On/Off/Level (whichever are action-kind) point at this
      // instance - a macro-bound function has no instanceId of its own,
      // so it never counts toward this check either way.
      const hasDefault = bindings[cat].some(
        (s) =>
          (!s.fixedArgs || Object.keys(s.fixedArgs).length === 0) &&
          [s.onFn, s.offFn, s.levelFn].some((f) => f && f.kind === "action" && f.instanceId === id)
      );
      if (hasDefault) continue;
      const { onAction, offAction, levelAction } = roleActionsForCategory(manifest, cat);
      if (!onAction && !offAction && !levelAction) continue;
      const { onState, levelState } = roleStatesForCategory(manifest, cat);
      const stateSuffix = detectSingleSuffix(entry, onState && onState.id) || detectSingleSuffix(entry, levelState && levelState.id);
      bindings[cat].push({
        id: crypto.randomBytes(4).toString("hex"),
        name: manifest.displayName,
        onFn: onAction ? { kind: "action", instanceId: id, actionId: onAction.id } : undefined,
        offFn: offAction ? { kind: "action", instanceId: id, actionId: offAction.id } : undefined,
        levelFn: levelAction ? { instanceId: id, actionId: levelAction.id } : undefined,
        onState: onState ? { instanceId: id, stateId: onState.id } : undefined,
        levelState: levelState ? { instanceId: id, stateId: levelState.id } : undefined,
        fixedArgs: {},
        stateSuffix,
      });
      added++;
    }
  }
  if (added) saveBindings();
  return added;
}

/** /api/bindings */
async function routes(req, res, parts) {
  if (parts[1] === "bindings" && parts.length === 2 && req.method === "GET") {
    return sendJson(res, 200, bindings);
  }
  if (parts[1] === "bindings" && parts.length === 2 && req.method === "PUT") {
    try {
      const body = await readJsonBody(req);
      bindings = sanitizeBindings(body);
      saveBindings();
      broadcast({ type: "bindings", bindings });
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }
  if (parts[1] === "bindings" && parts.length === 3 && parts[2] === "auto-generate" && req.method === "POST") {
    const added = autoGenerateBindings();
    broadcast({ type: "bindings", bindings });
    return sendJson(res, 200, { ok: true, added });
  }
  res.writeHead(404);
  res.end("Not found");
}

module.exports = { routes, sanitizeWidget, sanitizePage, sanitizeMeshBinding, sanitizeGlbScene, sanitizeLayoutBackground, sanitizeBindings };
