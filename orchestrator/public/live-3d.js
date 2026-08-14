// Live 3D view: a thin, page-specific wrapper around viewer3d.js's mesh-
// binding engine, mirroring the shape admin.js's editor uses (see
// viewer3d.js's header comment for why the viewer itself knows nothing
// about bindingsData/statesByInstance - both pages hand it callbacks
// instead). Read-only here - live.js is the customer-facing page, so
// there's no edit mode; tapping a bound mesh toggles its device exactly
// like tapping a flat card does, via the `dispatchToggle` callback the
// host page supplies.
import { create3DViewer } from "./viewer3d.js";
import { resolveMeshOnLevel, createGlbProgressHandler } from "./roles.js";

export function create3DPanel({ sceneRowId, getBindingsData, getStatesByInstance, dispatchToggle }) {
  let currentSceneId = null;
  let inited = false;

  function scenes() {
    return (getBindingsData().glbs) || [];
  }
  function currentScene() {
    return scenes().find((s) => s.id === currentSceneId);
  }

  const viewer3d = create3DViewer({
    editable: () => false,
    onDeviceClick: (mb) => dispatchToggle(mb),
    getMeshBindings: () => (currentScene() || {}).meshBindings || {},
    resolveOnLevel: (mb) => resolveMeshOnLevel(getBindingsData(), getStatesByInstance(), mb),
    onLoadProgress: createGlbProgressHandler("live3dProgressTrack", "live3dProgressBar"),
  });

  // A flat row of pill buttons (matching .sky-action-btn used elsewhere
  // on this page) rather than a <select> - a customer picking which
  // floor/room to view is a rare, low-cardinality choice best shown as
  // one-tap buttons, not hidden behind a dropdown.
  function renderSceneSelect() {
    const row = document.getElementById(sceneRowId);
    if (!row) return;
    const list = scenes();
    row.classList.toggle("sky-hidden", list.length < 2);
    row.innerHTML = list
      .map((s) => `<button type="button" class="sky-action-btn${s.id === currentSceneId ? " primary" : ""}" data-scene-id="${s.id}">${s.name}</button>`)
      .join("");
    row.querySelectorAll("[data-scene-id]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        currentSceneId = btn.dataset.sceneId;
        renderSceneSelect();
        await loadCurrentScene();
      });
    });
  }

  async function loadCurrentScene() {
    const scene = currentScene();
    if (scene && scene.url) viewer3d.loadGLB(scene.url);
  }

  // Returns whether there's anything to show - the host page uses this
  // to decide whether the 3D sidebar button appears at all, matching
  // QTI's own "3D is just another filterable category" treatment.
  function hasScenes() {
    return scenes().some((s) => s.url);
  }

  // Called every time the 3D category becomes/stays active - including
  // on every refresh() tick while it's already showing, since live.js
  // doesn't distinguish "just switched to 3D" from "still on 3D, state
  // changed" at the call site. Only reloads the GLB (a real network
  // fetch + full mesh re-traversal) on an actual scene change or first
  // show; otherwise just re-eases toward the latest state, exactly like
  // repeatedly calling show() while already visible should be free.
  async function show() {
    const list = scenes().filter((s) => s.url);
    if (!list.length) return false;
    const wantSceneId = currentSceneId && list.some((s) => s.id === currentSceneId) ? currentSceneId : list[0].id;
    const sceneChanged = wantSceneId !== currentSceneId;
    currentSceneId = wantSceneId;
    renderSceneSelect();
    if (!inited) {
      await viewer3d.init();
      inited = true;
      await loadCurrentScene();
    } else if (sceneChanged) {
      await loadCurrentScene();
    } else {
      viewer3d.updateVisuals();
    }
    return true;
  }

  // Called on every refresh() tick (state poll/WS push) while the 3D
  // panel is visible - keeps animated meshes in sync with real device
  // state the same way the flat card grid does, unconditionally (not
  // gated to "only if a light changed" the way QTI's own refreshFor once
  // was - that gate is what left QTI's own door/media meshes stale after
  // a sysvar push in the past, not worth reproducing here).
  function refresh() {
    if (inited) viewer3d.updateVisuals();
  }

  return { show, refresh, hasScenes };
}
