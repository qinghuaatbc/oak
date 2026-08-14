// Shared category/role resolution for admin.js (Dashboard bindings editor)
// and live.js (sidebar + cards) - kept in one module rather than
// duplicated per-file because these two UIs must resolve a driver's
// on/off/level identically or they'd silently disagree about what a
// control does.
//
// Dashboard presentation is driven by bindings.json "slots" (see
// server.js's loadBindings/saveBindings/autoGenerateBindings), matching
// QTI's own real binding shape rather than Oak's earlier 1-tile-per-
// instance approach:
//   {
//     id, name,
//     onFn:  {kind:"action", instanceId, actionId} | {kind:"macro", macroId} | undefined,
//     offFn: {kind:"action", instanceId, actionId} | {kind:"macro", macroId} | undefined,
//     levelFn: {instanceId, actionId} | undefined,   // action only - a macro has
//                                                     // no way to carry a live
//                                                     // drag value, so this never
//                                                     // gets a "kind" choice
//     onState:    {instanceId, stateId} | undefined,
//     levelState: {instanceId, stateId} | undefined,
//     fixedArgs, stateSuffix,
//   }
// On/Off/Level each independently name their OWN instance+action (or a
// macro, for on/off) - not one shared instance for the whole slot. This
// is what lets a real QTI-style binding express "On also runs a
// goodnight-style macro" or "On calls hub A but Off calls hub B", not
// just "this slot's 3 functions all happen to live on one instance". A
// hub-style driver backing many zones (e.g. "kitchen light" and "living
// room light" both against the same multi-zone controller) still works
// the same way it always did - fixedArgs (e.g. {zone:"kitchen"}) carries
// the zone into whichever action gets called, and stateSuffix reads the
// right zone back out of an instance's combined state object via
// driver.js's "id#instanceKey" convention (ctx.setState's 3rd argument):
// "light.on#kitchen" alongside "light.on#livingroom" in one instance's
// state.
export const CATEGORY_ICON = {
  light: "💡",
  switch: "🔌",
  security: "🔒",
  climate: "🌡️",
  media: "🎬",
  sensor: "📡",
  generic: "⚙️",
};
export const CATEGORY_LABEL = {
  light: "Light",
  switch: "Switch",
  security: "Security",
  climate: "Climate",
  media: "Media",
  sensor: "Sensor",
  generic: "Generic",
};
export const CATEGORY_ORDER = ["light", "switch", "climate", "security", "media", "sensor", "generic"];

// Still used for the "Add instance" two-step category-then-driver picker,
// and for guessing a sensible default category for an uploaded driver -
// NOT for Dashboard display anymore (that's entirely slot-driven now).
export function effectiveCategories(manifest) {
  const raw = manifest.category || "generic";
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.length ? arr : ["generic"];
}

export function findRoleAction(manifest, role) {
  return manifest.actions.find((a) => a.role === role);
}
export function findRoleState(manifest, role) {
  return manifest.states.find((s) => s.role === role);
}
export function findAction(manifest, actionId) {
  return manifest.actions.find((a) => a.id === actionId);
}

// Role-tagged first (reliable, driver-declared), falling back to the old
// turnOn/turnOff name heuristic only for a manifest with no role tags at
// all - keeps working for a hand-written driver that hasn't adopted roles
// yet, without reintroducing the armStay/disarm false-positive bug a
// name-only heuristic already caused twice this session once a manifest
// DOES use roles. Used by the Driver tab's raw Actions panel (an
// instance-level toggle, unrelated to Dashboard bindings) and to suggest
// defaults when an admin picks an instance for a new function.
export function getOnOffPair(manifest) {
  const onAction = findRoleAction(manifest, "on");
  const offAction = findRoleAction(manifest, "off");
  if (onAction && offAction) return [onAction.id, offAction.id];
  const ids = new Set(manifest.actions.map((a) => a.id));
  if (ids.has("turnOn") && ids.has("turnOff")) return ["turnOn", "turnOff"];
  return null;
}
export function getLevelAction(manifest) {
  return findRoleAction(manifest, "level");
}

// Reads a value back out of a (single instance's) state object, zone-
// aware via `suffix` (the "<stateId>#<suffix>" convention). `state`/
// `stateId` must already be resolved to the right instance by the
// caller - roles.js has no opinion on WHICH instance a slot's onState/
// levelState points at, only how to read a value out of that instance's
// state object once you hand it one.
export function readState(state, stateId, suffix) {
  if (!stateId) return undefined;
  const key = suffix ? `${stateId}#${suffix}` : stateId;
  return key in state ? state[key] : undefined;
}
// Same, but with the "any boolean state" fallback getOnOffPair's own
// name-heuristic fallback mirrors - only reachable when a slot has no
// explicit onState configured at all and no zone suffix (so there's
// nothing to disambiguate), e.g. a freshly hand-created slot.
export function readOnState(state, stateId, suffix) {
  if (stateId) {
    const key = suffix ? `${stateId}#${suffix}` : stateId;
    return key in state ? [key, state[key]] : undefined;
  }
  if (!suffix) return Object.entries(state).find(([, v]) => typeof v === "boolean");
  return undefined;
}

// Merges a slot's fixed call arguments (e.g. {zone:"kitchen"}) with
// whatever extra param the UI is setting live (e.g. a dragged level
// value) - extra always wins on key collision.
export function slotCallParams(slot, extra) {
  return { ...(slot && slot.fixedArgs), ...extra };
}

// "Which instance's running-state represents this slot" - a slot's
// On/Off/Level/onState/levelState can each reference a DIFFERENT
// instance (a macro-bound On, an Off on a different hub, etc.), so
// there's no single "the" instance anymore. Level wins first (it's the
// most likely to be this slot's real device when present), then
// whichever action-kind On/Off is set, then whichever state ref is set -
// good enough for an offline badge without needing to track every
// referenced instance's running-state independently. Shared by live.js's
// card grid and viewer3d.js's mesh bindings - both need the same answer.
export function primaryInstanceId(slot) {
  if (slot.levelFn) return slot.levelFn.instanceId;
  if (slot.onFn && slot.onFn.kind === "action") return slot.onFn.instanceId;
  if (slot.offFn && slot.offFn.kind === "action") return slot.offFn.instanceId;
  if (slot.onState) return slot.onState.instanceId;
  if (slot.levelState) return slot.levelState.instanceId;
  return undefined;
}
export function slotOnEntry(slot, state) {
  return slot.onState ? readOnState(state, slot.onState.stateId, slot.stateSuffix) : undefined;
}
export function slotLevelValue(slot, state) {
  return slot.levelState ? readState(state, slot.levelState.stateId, slot.stateSuffix) : undefined;
}

// Dispatches a slot's On/Off function, which is either a single action
// call or a macro run (the slot shape's only two function-ref "kinds" -
// see this file's header comment). A macro run takes no params (its
// steps carry their own fixed args, configured on the Macro tab) - the
// slot's own fixedArgs only apply to the action case. Takes callAction/
// runMacro as params rather than importing api.js directly, so this
// stays usable from viewer3d.js too without that module needing to know
// about the fetch layer.
export function callFn(fn, slot, { callAction, runMacro }) {
  if (!fn) return Promise.resolve();
  if (fn.kind === "macro") return runMacro(fn.macroId);
  return callAction(fn.instanceId, fn.actionId, slotCallParams(slot));
}

// A 3D mesh binding is a POINTER {cat, id} into bindingsData[cat], not a
// copy of a slot - see server.js's sanitizeMeshBinding comment. Looking
// it up here (rather than duplicating slot data into the mesh binding)
// means a scene's device wiring always reflects the Dashboard tab's own
// current slot definition, with exactly one source of truth.
export function bindingSlot(bindingsData, mb) {
  if (!mb || !bindingsData[mb.cat]) return undefined;
  return bindingsData[mb.cat].find((s) => s.id === mb.id);
}

// Resolves a mesh binding's live on/level exactly the way a Dashboard
// ring card does (slotOnEntry/slotLevelValue above) - shared by the admin
// 3D editor and the live 3D view so both agree with each other, and with
// the flat card grid, about what "on" means for a given slot.
export function resolveMeshOnLevel(bindingsData, statesByInstance, mb) {
  const slot = bindingSlot(bindingsData, mb);
  if (!slot) return { on: false, level: 0 };
  const state = statesByInstance.get(primaryInstanceId(slot)) || {};
  const onEntry = slotOnEntry(slot, state);
  const levelValue = slotLevelValue(slot, state);
  const on = onEntry ? onEntry[1] : levelValue > 0;
  return { on, level: levelValue !== undefined ? levelValue : on ? 100 : 0 };
}

// Mesh animation vocabulary - matches QTI's own create3DViewer exactly
// (QTI is this project's own prior work, not RTI's - reusing an
// already-proven design, not approximating one). ANIM_TYPES is ordered
// for the admin bind-picker's <select>; AXIS_ANIM_TYPES marks which ones
// need an axis+direction row (a plain glow/pulse has neither).
export const ANIM_TYPES = [
  { value: "", label: "None (click only)" },
  { value: "light", label: "Glow" },
  { value: "pulse", label: "Pulse (media)" },
  { value: "rotate", label: "Rotate 90° (swing door)" },
  { value: "slide", label: "Slide open (sliding door/window)" },
  { value: "roller", label: "Roll up (shutter/blind)" },
];
export const AXIS_ANIM_TYPES = new Set(["rotate", "slide", "roller"]);
