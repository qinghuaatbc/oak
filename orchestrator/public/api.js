// Thin fetch wrapper shared by admin.js and live.js.
//
// Every id used as a URL path segment goes through encodeURIComponent()
// - an instance/driver/camera/macro id can contain spaces or other
// URL-special characters (e.g. typed straight from a driver's display
// name instead of a slug, like "Generic dimmer"), and a raw, unencoded
// id in the URL either gets silently mismatched against the server's
// stored key or, worse, characters like "#" get interpreted as a URL
// fragment and never reach the server at all. Confirmed as a real,
// live bug: an instance named with a space could be listed but not
// stopped, started, or deleted - every route referencing it 404'd.

export async function listInstances() {
  return (await fetch("/api/instances")).json();
}
export async function getManifest(id) {
  return (await fetch(`/api/instances/${encodeURIComponent(id)}/manifest`)).json();
}
export async function getState(id) {
  return (await fetch(`/api/instances/${encodeURIComponent(id)}/state`)).json();
}
export async function getEvents(id) {
  return (await fetch(`/api/instances/${encodeURIComponent(id)}/events`)).json();
}
export async function callAction(id, actionId, params) {
  const res = await fetch(`/api/instances/${encodeURIComponent(id)}/action/${encodeURIComponent(actionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params || {}),
  });
  return res.json();
}
export async function listDrivers() {
  return (await fetch("/api/drivers")).json();
}
export async function uploadDriver(driverId, manifestJson, driverJs) {
  const res = await fetch("/api/drivers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ driverId, manifestJson, driverJs }),
  });
  return res.json();
}
export async function deleteDriverPackage(driverId) {
  const res = await fetch(`/api/drivers/${encodeURIComponent(driverId)}`, { method: "DELETE" });
  return res.json();
}
export async function addInstance(id, driver, connection, settings, label) {
  const res = await fetch("/api/instances", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, driver, connection, settings, label }),
  });
  return res.json();
}
export async function deleteInstance(id) {
  const res = await fetch(`/api/instances/${encodeURIComponent(id)}`, { method: "DELETE" });
  return res.json();
}
export async function getConfig(id) {
  return (await fetch(`/api/instances/${encodeURIComponent(id)}/config`)).json();
}
export async function editInstance(id, updates) {
  const res = await fetch(`/api/instances/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  return res.json();
}
export async function stopInstance(id) {
  const res = await fetch(`/api/instances/${encodeURIComponent(id)}/stop`, { method: "POST" });
  return res.json();
}
export async function startInstance(id) {
  const res = await fetch(`/api/instances/${encodeURIComponent(id)}/start`, { method: "POST" });
  return res.json();
}

export async function getHealth() {
  return (await fetch("/api/health")).json();
}

export async function getBindings() {
  return (await fetch("/api/bindings")).json();
}
export async function saveBindings(bindings) {
  const res = await fetch("/api/bindings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bindings),
  });
  return res.json();
}
export async function autoGenerateBindings() {
  const res = await fetch("/api/bindings/auto-generate", { method: "POST" });
  return res.json();
}

export async function listMacros() {
  return (await fetch("/api/macros")).json();
}
export async function saveMacro(macro) {
  const res = await fetch("/api/macros", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(macro),
  });
  return res.json();
}
export async function deleteMacro(id) {
  const res = await fetch(`/api/macros/${encodeURIComponent(id)}`, { method: "DELETE" });
  return res.json();
}
export async function runMacro(id) {
  const res = await fetch(`/api/macros/${encodeURIComponent(id)}/run`, { method: "POST" });
  return res.json();
}

export async function listAutomations() {
  return (await fetch("/api/automations")).json();
}
export async function saveAutomation(automation) {
  const res = await fetch("/api/automations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(automation),
  });
  return res.json();
}
export async function deleteAutomation(id) {
  const res = await fetch(`/api/automations/${encodeURIComponent(id)}`, { method: "DELETE" });
  return res.json();
}
export async function runAutomation(id) {
  const res = await fetch(`/api/automations/${encodeURIComponent(id)}/run`, { method: "POST" });
  return res.json();
}

export async function getSettings() {
  return (await fetch("/api/settings")).json();
}
export async function saveSettings(settings) {
  const res = await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  return res.json();
}

export async function listCameras() {
  return (await fetch("/api/cameras")).json();
}
export async function addCamera(name, rtspUrl) {
  const res = await fetch("/api/cameras", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, rtspUrl }),
  });
  return res.json();
}
export async function deleteCamera(id) {
  const res = await fetch(`/api/cameras/${encodeURIComponent(id)}`, { method: "DELETE" });
  return res.json();
}

export async function listGlbModels() {
  return (await fetch("/api/glb")).json();
}
export async function uploadGlb(filename, dataBase64) {
  const res = await fetch("/api/glb-upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename, dataBase64 }),
  });
  return res.json();
}
