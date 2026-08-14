// Shared category/role resolution for admin.js (Dashboard bindings editor)
// and live.js (sidebar + cards) - kept in one module rather than
// duplicated per-file because these two UIs must resolve a driver's
// on/off/level identically or they'd silently disagree about what a
// control does.
//
// Dashboard presentation is driven by bindings.json "slots", not by the
// driver instance directly (see server.js's loadBindings/saveBindings/
// autoGenerateBindings) - a slot is {id, name, instanceId, onActionId,
// offActionId, levelActionId, fixedArgs, stateSuffix}. This is what lets
// one hub-style instance (e.g. a real multi-zone controller exporting one
// action per role but taking a zone/name parameter) back MANY slots -
// "kitchen light" and "living room light" both point at the same
// instance's same turnOn/turnOff actions, just with different fixedArgs
// (e.g. {zone:"kitchen"}) and a different stateSuffix to read the right
// zone's state back (state key convention: "<stateId>#<suffix>", e.g.
// "light.on#kitchen" alongside "light.on#livingroom" in one instance's
// state object).
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
// and by autoGenerateBindings-adjacent client code that wants to guess a
// sensible default category for a newly bound slot - NOT for Dashboard
// display anymore (that's entirely slot-driven now).
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
// yet, without reintroducing the armStay/disarm false-positive bug a name-
// only heuristic already caused twice this session once a manifest DOES
// use roles (a role-tagged "arm" action is never mistaken for "on"). Used
// to suggest defaults when an admin picks an instance for a new slot, and
// by autoGenerateBindings' client-side equivalent.
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

// Resolves a slot's actual on/level state, zone-aware via
// slot.stateSuffix. Reads the slot's OWN explicit onStateId/levelStateId
// (set by autoGenerateBindings or picked by hand in the admin editor) -
// NOT a manifest-wide role scan. That distinction matters for a hub
// manifest like zone-hub: a blind "find the state with role=level" would
// always return light.level, even for a climate slot asking about
// climate.target (which has no role tag at all, deliberately, since
// there's no settled climate role vocabulary yet) - the same "multiple
// actions/states with the same role in one manifest" ambiguity
// server.js's roleActionsForCategory already has to solve for actions.
// Falls back to role-based lookup only for a slot with no explicit
// onStateId/levelStateId set (an older auto-generated slot, or a
// single-subsystem manifest where the ambiguity can't arise), and
// further falls back to "any boolean state" for a manifest with no role
// tags at all - same fallback getOnOffPair uses for actions.
export function slotOnState(manifest, state, slot) {
  const suffix = slot && slot.stateSuffix;
  const stateId = (slot && slot.onStateId) || (findRoleState(manifest, "on") || {}).id;
  if (stateId) {
    const key = suffix ? `${stateId}#${suffix}` : stateId;
    if (key in state) return [key, state[key]];
    if (!suffix) return undefined;
  }
  if (!suffix) return Object.entries(state).find(([, v]) => typeof v === "boolean");
  return undefined;
}
export function slotLevelState(manifest, state, slot) {
  const stateId = (slot && slot.levelStateId) || (findRoleState(manifest, "level") || {}).id;
  if (!stateId) return undefined;
  const suffix = slot && slot.stateSuffix;
  const key = suffix ? `${stateId}#${suffix}` : stateId;
  return key in state ? state[key] : undefined;
}

// Merges a slot's fixed call arguments (e.g. {zone:"kitchen"}) with
// whatever extra param the UI is setting live (e.g. a dragged level
// value) - extra always wins on key collision.
export function slotCallParams(slot, extra) {
  return { ...(slot && slot.fixedArgs), ...extra };
}
