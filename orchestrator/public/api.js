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
export async function addInstance(id, driver, connection, settings) {
  const res = await fetch("/api/instances", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, driver, connection, settings }),
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
export async function editInstance(id, connection, settings) {
  const res = await fetch(`/api/instances/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ connection, settings }),
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
