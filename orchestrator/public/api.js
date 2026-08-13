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
