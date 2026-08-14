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
