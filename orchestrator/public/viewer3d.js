// Port of QTI's shared.js create3DViewer, including the mesh-to-device
// binding/animation engine this time (QTI is this project's own prior
// work, not RTI's, so this is reusing an already-proven design rather
// than approximating one - see SPEC.md/roles.js for the mesh-binding
// shape). Scene/camera/renderer/lights/OrbitControls setup and GLB
// loading are unchanged from the original scoped-down port; everything
// below "loadGLB" is new.
//
// This module stays instance-agnostic: it has no idea what a driver
// instance or a bindings.json slot is. The host page (admin.js's editor,
// live-3d.js's live view) hands it a small callback surface instead -
// `opts.getMeshBindings()` to read the current scene's mesh->device map,
// `opts.resolveOnLevel(mb)` to ask the host what a binding's current on/
// level state is (the host owns bindingsData/statesByInstance, viewer3d
// doesn't), and `opts.onDeviceClick`/`opts.onEditClick` to hand click
// events back. This is the same shape QTI's own create3DViewer(opts)
// takes, for the same reason: one viewer implementation, reused
// identically by the admin editor and every live page.
export function create3DViewer(opts) {
  opts = opts || {};
  const g3d = {
    THREE: null,
    scene: null,
    camera: null,
    renderer: null,
    controls: null,
    model: null,
    loader: null,
    meshes: [], // flat list of every THREE.Mesh in the current model, found by .isMesh (not by naming convention)
    modelRadius: 5, // whole-model bounding size - down-light falloff uses THIS, never a bound mesh's own tiny box (see ensureDownLight)
    downLights: new Map(), // meshName -> THREE.SpotLight, lazily created, torn down on scene reload
  };

  const ROLLER_MIN_SCALE = 0.05; // "rolled up" = squashed to 5% of original scale on one axis
  const LERP_FAST = 0.08; // rotate/slide ease-per-frame factor
  const LERP_SLOW = 0.05; // roller eases slower - it's a bigger visual change, a fast snap read as glitchy

  async function init() {
    const [THREE, { GLTFLoader }, { OrbitControls }] = await Promise.all([
      import("three"),
      import("three/addons/loaders/GLTFLoader.js"),
      import("three/addons/controls/OrbitControls.js"),
    ]);
    g3d.THREE = THREE;
    g3d.loader = new GLTFLoader();

    const wrap = document.getElementById(opts.wrapId || "canvas3dWrap");
    if (!wrap) return;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, wrap.clientWidth / wrap.clientHeight, 0.1, 1000);
    camera.position.set(3, 3, 5);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(wrap.clientWidth, wrap.clientHeight);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    wrap.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    scene.add(new THREE.HemisphereLight(0xddeeff, 0x111122, 0.5));
    const dir = new THREE.DirectionalLight(0xffffff, 1.2);
    dir.position.set(5, 8, 4);
    scene.add(dir);

    // A tiny nonzero Z offset (not exactly (0, y, 0)) - OrbitControls
    // needs a well-defined "up" vector to compute yaw from, and a
    // perfectly vertical camera axis is degenerate (gimbal-locked).
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    g3d.scene = scene;
    g3d.camera = camera;
    g3d.renderer = renderer;
    g3d.controls = controls;

    new ResizeObserver(() => {
      if (!wrap.clientWidth || !wrap.clientHeight) return;
      camera.aspect = wrap.clientWidth / wrap.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(wrap.clientWidth, wrap.clientHeight);
    }).observe(wrap);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    renderer.domElement.addEventListener("click", (ev) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(g3d.meshes, false);
      if (!hits.length) return;
      const mesh = hits[0].object;
      if (opts.editable && opts.editable()) {
        if (opts.onEditClick) opts.onEditClick(mesh.name, ev.clientX, ev.clientY);
        return;
      }
      const mb = (opts.getMeshBindings ? opts.getMeshBindings() : {})[mesh.name];
      if (mb && opts.onDeviceClick) opts.onDeviceClick(mb);
    });

    (function animate() {
      requestAnimationFrame(animate);
      controls.update();
      updateMeshAnimations();
      renderer.render(scene, camera);
    })();
  }

  function clearDownLights() {
    for (const light of g3d.downLights.values()) {
      g3d.scene.remove(light.target);
      g3d.scene.remove(light);
    }
    g3d.downLights.clear();
  }

  function loadGLB(url) {
    // g3d.loader is created before the WebGLRenderer, so a renderer
    // construction failure (e.g. no WebGL available at all) can leave
    // loader truthy but scene/camera never assigned - guard on scene too,
    // otherwise this throws reading `.remove` on null a few lines down.
    if (!g3d.loader || !g3d.scene) return;
    if (g3d.model) {
      g3d.scene.remove(g3d.model);
      g3d.model = null;
    }
    clearDownLights();
    g3d.meshes = [];
    g3d.loader.load(
      url,
      (gltf) => {
        g3d.model = gltf.scene;
        g3d.scene.add(g3d.model);
        const box = new g3d.THREE.Box3().setFromObject(g3d.model);
        const size = box.getSize(new g3d.THREE.Vector3());
        const diag = size.length() || 5;
        g3d.modelRadius = Math.max(size.x, size.y, size.z) || 5;
        const center = box.getCenter(new g3d.THREE.Vector3());
        g3d.controls.target.copy(center);
        g3d.camera.position.copy(center).add(new g3d.THREE.Vector3(diag * 0.6, diag * 0.6, diag * 0.6));
        g3d.camera.near = diag / 100;
        g3d.camera.far = diag * 100;
        g3d.camera.updateProjectionMatrix();

        // Per-mesh baseline, captured once at load time exactly as
        // authored in the GLB - every animation eases toward/away from
        // THIS, never a hardcoded absolute value. Confirmed necessary the
        // hard way in QTI: animating scale to an absolute number (e.g.
        // 1.08) broke on a mesh with a tiny baked-in original scale,
        // ballooning it to ~200x size - relative-to-original is the only
        // safe approach for any mesh whose authored transform isn't 1:1.
        g3d.model.traverse((obj) => {
          if (!obj.isMesh) return;
          obj.userData._origPosition = obj.position.clone();
          obj.userData._origRotation = obj.rotation.clone();
          obj.userData._origScale = obj.scale.clone();
          if (obj.material && "emissive" in obj.material) {
            obj.userData._origEmissive = obj.material.emissive.clone();
            obj.userData._origEmissiveIntensity = obj.material.emissiveIntensity;
          }
          obj.userData._bindKey = null;
          g3d.meshes.push(obj);
        });
        updateVisuals();
      },
      undefined,
      (err) => console.error("GLB load failed:", err)
    );
  }

  function meshByName(name) {
    return g3d.meshes.find((m) => m.name === name);
  }

  // Anchored at the bound mesh's own position but sized against the
  // WHOLE MODEL's radius, not the mesh's own (usually tiny) bounding box
  // - using the mesh's own box made the falloff cut off almost
  // immediately, reading as "no downward glow" (a real gotcha QTI hit).
  function ensureDownLight(mesh) {
    if (g3d.downLights.has(mesh.name)) return g3d.downLights.get(mesh.name);
    const light = new g3d.THREE.SpotLight(0xfff2cc, 0, g3d.modelRadius * 1.2, Math.PI / 4, 0.4, 1.5);
    const meshBox = new g3d.THREE.Box3().setFromObject(mesh);
    const center = meshBox.getCenter(new g3d.THREE.Vector3());
    light.position.copy(center);
    light.target.position.copy(center).add(new g3d.THREE.Vector3(0, -1, 0));
    g3d.scene.add(light);
    g3d.scene.add(light.target);
    g3d.downLights.set(mesh.name, light);
    return light;
  }
  function removeDownLight(meshName) {
    const light = g3d.downLights.get(meshName);
    if (!light) return;
    g3d.scene.remove(light.target);
    g3d.scene.remove(light);
    g3d.downLights.delete(meshName);
  }

  // Called by the host whenever bindings or live state change (bound
  // mesh added/removed/rebound, or a driver's on/off/level state
  // changed) - recomputes every mesh's animation TARGET. The actual
  // transform is eased toward that target every frame by
  // updateMeshAnimations() below, never set directly here (so a rapid
  // sequence of updateVisuals() calls, e.g. a burst of WS state pushes,
  // never causes a visible snap - only the final target matters).
  function updateVisuals() {
    const bindings = opts.getMeshBindings ? opts.getMeshBindings() : {};
    for (const mesh of g3d.meshes) {
      const mb = bindings[mesh.name];
      if (!mb) {
        if (mesh.userData._bindKey) {
          // Was bound, now isn't (unbound in the editor) - snap back to
          // the authored baseline instead of leaving it stuck wherever
          // its last animation left it.
          snapToOriginal(mesh);
          mesh.userData._bindKey = null;
        }
        continue;
      }
      const bindKey = [mb.cat, mb.id, mb.animType, mb.axis, mb.dir].join(":");
      if (mesh.userData._bindKey !== bindKey) {
        // Binding identity changed (rebind/retype/unbind-then-rebind) -
        // snap instantly to the authored baseline before establishing a
        // new target, so a mesh never gets left stuck mid-slide/rotate
        // from whatever its PREVIOUS binding was animating toward.
        snapToOriginal(mesh);
        removeDownLight(mesh.name);
        mesh.userData._bindKey = bindKey;
      }
      const { on, level } = (opts.resolveOnLevel ? opts.resolveOnLevel(mb) : {}) || {};
      applyTarget(mesh, mb, Boolean(on), typeof level === "number" ? level : on ? 100 : 0);
    }
  }

  function snapToOriginal(mesh) {
    mesh.position.copy(mesh.userData._origPosition);
    mesh.rotation.copy(mesh.userData._origRotation);
    mesh.scale.copy(mesh.userData._origScale);
    if (mesh.material && mesh.userData._origEmissive) {
      mesh.material.emissive.copy(mesh.userData._origEmissive);
      mesh.material.emissiveIntensity = mesh.userData._origEmissiveIntensity;
    }
    mesh.userData._pulseEnabled = false;
    mesh.userData._target = null;
  }

  function applyTarget(mesh, mb, on, level) {
    const orig = mesh.userData;
    if (mb.animType === "light" || (!mb.animType && mb.cat === "light")) {
      // Legacy fallback matches QTI's own: a binding with no animType at
      // all still gets the glow treatment when it's a light.
      if (mesh.material && "emissive" in mesh.material) {
        mesh.material.emissive.setHex(0xfff2cc);
        mesh.material.emissiveIntensity = on ? Math.max(0.15, level / 100) : 0;
      }
      const light = ensureDownLight(mesh);
      light.intensity = on ? (level / 100) * g3d.modelRadius * 1.5 : 0;
      orig._pulseEnabled = false;
      orig._target = null;
      return;
    }
    if (mb.animType === "pulse") {
      orig._pulseEnabled = on;
      if (!on) orig._target = { scale: orig._origScale.clone() };
      if (mesh.material && "emissive" in mesh.material) {
        mesh.material.emissive.setHex(0xfff2cc);
        mesh.material.emissiveIntensity = on ? Math.max(0.15, level / 100) : 0;
      }
      return;
    }
    if (mb.animType === "rotate") {
      const base = orig._origRotation[mb.axis];
      const target = orig._origRotation.clone();
      target[mb.axis] = base + (on ? (Math.PI / 2) * mb.dir : 0);
      orig._target = { rotation: target };
      return;
    }
    if (mb.animType === "slide") {
      const meshBox = new g3d.THREE.Box3().setFromObject(mesh);
      const size = meshBox.getSize(new g3d.THREE.Vector3());
      const dist = size[mb.axis] || 1;
      const base = orig._origPosition[mb.axis];
      const target = orig._origPosition.clone();
      target[mb.axis] = base + (on ? dist * mb.dir : 0);
      orig._target = { position: target };
      return;
    }
    if (mb.animType === "roller") {
      const origOnAxis = orig._origScale[mb.axis];
      const target = orig._origScale.clone();
      target[mb.axis] = on ? origOnAxis * ROLLER_MIN_SCALE : origOnAxis;
      orig._target = { scale: target };
      return;
    }
    // animType "" (none) - click-only, no visual feedback beyond hit-testing.
    orig._target = null;
    orig._pulseEnabled = false;
  }

  function updateMeshAnimations() {
    const now = performance.now() / 1000;
    for (const mesh of g3d.meshes) {
      const ud = mesh.userData;
      if (ud._pulseEnabled) {
        const s = 1 + Math.sin(now * 1.6) * 0.22;
        const orig = ud._origScale;
        mesh.scale.set(orig.x * s, orig.y * s, orig.z * s);
        continue;
      }
      const target = ud._target;
      if (!target) continue;
      if (target.position) {
        const f = LERP_FAST;
        mesh.position.x += (target.position.x - mesh.position.x) * f;
        mesh.position.y += (target.position.y - mesh.position.y) * f;
        mesh.position.z += (target.position.z - mesh.position.z) * f;
      }
      if (target.rotation) {
        const f = LERP_FAST;
        mesh.rotation.x += (target.rotation.x - mesh.rotation.x) * f;
        mesh.rotation.y += (target.rotation.y - mesh.rotation.y) * f;
        mesh.rotation.z += (target.rotation.z - mesh.rotation.z) * f;
      }
      if (target.scale) {
        const f = LERP_SLOW;
        mesh.scale.x += (target.scale.x - mesh.scale.x) * f;
        mesh.scale.y += (target.scale.y - mesh.scale.y) * f;
        mesh.scale.z += (target.scale.z - mesh.scale.z) * f;
      }
    }
  }

  function getMeshNames() {
    return g3d.meshes.map((m) => m.name).filter(Boolean);
  }

  return { init, loadGLB, updateVisuals, getMeshNames, meshByName };
}
