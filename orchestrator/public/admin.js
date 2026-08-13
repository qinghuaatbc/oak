import { listInstances, getManifest, getState, getEvents, callAction } from "./api.js";

const POLL_MS = 2000;
const root = document.getElementById("instances");
let manifests = new Map(); // id -> manifest, fetched once per instance

function fieldInputs(action) {
  return (action.params || [])
    .map(
      (p) =>
        `<input name="${p.key}" type="${p.type === "number" ? "number" : "text"}" placeholder="${p.key}${
          p.default !== undefined ? " = " + p.default : ""
        }" />`
    )
    .join("");
}

function renderInstancePanel(id, manifest, state, events) {
  const stateRows = Object.entries(state)
    .map(([key, value]) => `<tr><td>${key}</td><td>${formatValue(value)}</td></tr>`)
    .join("");

  const actionForms = manifest.actions
    .map(
      (a) => `
      <form data-instance="${id}" data-action="${a.id}">
        <button type="submit">${a.label}</button>
        ${fieldInputs(a)}
      </form>`
    )
    .join("");

  const eventLines = events
    .slice()
    .reverse()
    .map((e) => `<div>${new Date(e.t).toLocaleTimeString()} — ${e.id} ${JSON.stringify(e.params)}</div>`)
    .join("");

  return `
    <section class="panel" data-panel="${id}">
      <h2>${manifest.displayName}</h2>
      <p class="sub">instance "${id}" · driver ${manifest.id}</p>
      <table><thead><tr><th>state</th><th>value</th></tr></thead><tbody>${
        stateRows || `<tr><td colspan="2" class="sub">no state yet</td></tr>`
      }</tbody></table>
      <div class="actions">${actionForms}</div>
      <div class="events">${eventLines || `<div class="sub">no events yet</div>`}</div>
    </section>`;
}

function formatValue(v) {
  if (typeof v === "boolean") return `<span class="pill ${v ? "on" : "off"}">${v ? "on" : "off"}</span>`;
  return String(v);
}

async function refresh() {
  const list = await listInstances();
  const panels = await Promise.all(
    list.map(async (summary) => {
      if (!manifests.has(summary.id)) manifests.set(summary.id, await getManifest(summary.id));
      const manifest = manifests.get(summary.id);
      const [state, events] = await Promise.all([getState(summary.id), getEvents(summary.id)]);
      return renderInstancePanel(summary.id, manifest, state, events);
    })
  );
  root.innerHTML = panels.join("") || `<p class="sub">No instances configured.</p>`;
  wireForms();
}

function wireForms() {
  root.querySelectorAll("form[data-instance]").forEach((form) => {
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const instanceId = form.dataset.instance;
      const actionId = form.dataset.action;
      const params = {};
      form.querySelectorAll("input").forEach((input) => {
        if (input.value === "") return;
        params[input.name] = input.type === "number" ? Number(input.value) : input.value;
      });
      try {
        await callAction(instanceId, actionId, params);
      } catch (err) {
        console.error("action failed", err);
      }
      refresh();
    });
  });
}

refresh();
setInterval(refresh, POLL_MS);
