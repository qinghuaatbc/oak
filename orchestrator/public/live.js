// Simplified, customer-facing view: tap-to-trigger tiles only, no raw
// parameter forms and no event log - the technical detail admin.js shows
// stays on the admin side, same split QTI draws between its admin and
// live surfaces.
import { listInstances, getManifest, getState, callAction } from "./api.js";

const POLL_MS = 2000;
const root = document.getElementById("instances");
let manifests = new Map();

function statePillsFor(manifest, state) {
  return (manifest.states || [])
    .map((s) => {
      // perInstance states (e.g. one per zone/relay) may have several
      // "id#key" entries in the flat state map - show each one found.
      const matches = Object.entries(state).filter(([k]) => k === s.id || k.startsWith(s.id + "#"));
      return matches
        .map(([k, v]) => {
          const suffix = k.includes("#") ? ` ${k.split("#")[1]}` : "";
          return typeof v === "boolean" ? `<span class="pill ${v ? "on" : "off"}">${s.id}${suffix}: ${v ? "on" : "off"}</span>` : "";
        })
        .join(" ");
    })
    .join(" ");
}

function renderGroup(id, manifest, state) {
  const tiles = manifest.actions
    .map(
      (a) => `
      <div class="tile" data-instance="${id}" data-action="${a.id}">
        <div class="label">${a.label}</div>
        <div class="instance">${manifest.displayName}</div>
      </div>`
    )
    .join("");
  const pills = statePillsFor(manifest, state);
  return `<section class="panel">
    <h2>${manifest.displayName} <span class="sub">(${id})</span></h2>
    ${pills ? `<div class="state">${pills}</div>` : ""}
    <div class="tiles">${tiles}</div>
  </section>`;
}

async function refresh() {
  const list = await listInstances();
  const groups = await Promise.all(
    list.map(async (summary) => {
      if (!manifests.has(summary.id)) manifests.set(summary.id, await getManifest(summary.id));
      const manifest = manifests.get(summary.id);
      const state = await getState(summary.id);
      return renderGroup(summary.id, manifest, state);
    })
  );
  root.innerHTML = groups.join("") || `<p class="sub">No instances configured.</p>`;
  wireTiles();
}

function wireTiles() {
  root.querySelectorAll(".tile").forEach((tile) => {
    tile.addEventListener("click", async () => {
      tile.style.opacity = "0.5";
      try {
        await callAction(tile.dataset.instance, tile.dataset.action, {});
      } catch (err) {
        console.error("action failed", err);
      }
      await refresh();
    });
  });
}

refresh();
setInterval(refresh, POLL_MS);
