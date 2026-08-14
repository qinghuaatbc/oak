// Shared category/role resolution for admin.js (Dashboard) and live.js
// (sidebar) - kept in one module rather than duplicated per-file (unlike
// the small protocol-specific helpers elsewhere in this project) because
// these two UIs must resolve a manifest's category/on/off/level identically
// or they'd silently disagree about what a driver "is".
//
// A manifest declares `category` as a single string OR an array - a hub-
// style driver (e.g. a real ISY994/Eisy-equivalent controlling several
// lights AND a thermostat through one running instance) can genuinely
// belong to more than one category at once. An instance appears under
// EVERY category it declares, not split into separate per-device-type
// cards - Oak has no driver yet whose actions/states are annotated finely
// enough (e.g. "zone 3 is a light, zone 4 is a thermostat") to split a
// single instance's controls into separate widgets, so this is the
// honest v1 scope, not a missing feature silently papered over.
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

// override (from the instance's own spec, set via the Config tab) always
// wins over the manifest's own declared default - the "can still be
// manually modified" the whole category system was asked to keep.
export function effectiveCategories(manifest, override) {
  const raw = override && override.length ? override : manifest.category || "generic";
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.length ? arr : ["generic"];
}

export function findRoleAction(manifest, role) {
  return manifest.actions.find((a) => a.role === role);
}
export function findRoleState(manifest, role) {
  return manifest.states.find((s) => s.role === role);
}

// Role-tagged first (reliable, driver-declared), falling back to the old
// turnOn/turnOff name heuristic only for a manifest with no role tags at
// all - keeps working for a hand-written driver that hasn't adopted roles
// yet, without reintroducing the armStay/disarm false-positive bug a name-
// only heuristic already caused twice this session once a manifest DOES
// use roles (a role-tagged "arm" action is never mistaken for "on").
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
export function getOnState(manifest, state) {
  const roleState = findRoleState(manifest, "on");
  if (roleState) return Object.entries(state).find(([k]) => k === roleState.id || k.startsWith(roleState.id + "#"));
  return Object.entries(state).find(([, v]) => typeof v === "boolean");
}
export function getLevelState(manifest, state) {
  const roleState = findRoleState(manifest, "level");
  if (!roleState) return undefined;
  const entry = Object.entries(state).find(([k]) => k === roleState.id || k.startsWith(roleState.id + "#"));
  return entry ? entry[1] : undefined;
}
