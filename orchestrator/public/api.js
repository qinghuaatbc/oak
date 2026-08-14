// Thin fetch wrapper shared by admin.js and live.js.

export async function listInstances() {
  return (await fetch("/api/instances")).json();
}
export async function getManifest(id) {
  return (await fetch(`/api/instances/${id}/manifest`)).json();
}
export async function getState(id) {
  return (await fetch(`/api/instances/${id}/state`)).json();
}
export async function getEvents(id) {
  return (await fetch(`/api/instances/${id}/events`)).json();
}
export async function callAction(id, actionId, params) {
  const res = await fetch(`/api/instances/${id}/action/${actionId}`, {
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
  const res = await fetch(`/api/drivers/${driverId}`, { method: "DELETE" });
  return res.json();
}
export async function addInstance(id, driver, connection, settings, categoryOverride) {
  const res = await fetch("/api/instances", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, driver, connection, settings, categoryOverride }),
  });
  return res.json();
}
export async function deleteInstance(id) {
  const res = await fetch(`/api/instances/${id}`, { method: "DELETE" });
  return res.json();
}
export async function getConfig(id) {
  return (await fetch(`/api/instances/${id}/config`)).json();
}
export async function editInstance(id, updates) {
  const res = await fetch(`/api/instances/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  return res.json();
}
export async function stopInstance(id) {
  const res = await fetch(`/api/instances/${id}/stop`, { method: "POST" });
  return res.json();
}
export async function startInstance(id) {
  const res = await fetch(`/api/instances/${id}/start`, { method: "POST" });
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
  const res = await fetch(`/api/macros/${id}`, { method: "DELETE" });
  return res.json();
}
export async function runMacro(id) {
  const res = await fetch(`/api/macros/${id}/run`, { method: "POST" });
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
  const res = await fetch(`/api/cameras/${id}`, { method: "DELETE" });
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
