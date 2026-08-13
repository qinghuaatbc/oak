// Scoped-down port of QTI's shared.js create3DViewer: scene/camera/
// renderer/lights/OrbitControls setup and GLB loading are reused as-is.
// Deliberately NOT ported: mesh-to-device binding, click-to-toggle, animated
// roller/slide meshes - Oak has no room/device-position data anywhere in
// its data model yet to bind meshes to, so this is upload-and-view only.
export function create3DViewer() {
  const g3d = { THREE: null, scene: null, camera: null, renderer: null, controls: null, model: null, loader: null };

  async function init() {
    const [THREE, { GLTFLoader }, { OrbitControls }] = await Promise.all([
      import("three"),
      import("three/addons/loaders/GLTFLoader.js"),
      import("three/addons/controls/OrbitControls.js"),
    ]);
    g3d.THREE = THREE;
    g3d.loader = new GLTFLoader();

    const wrap = document.getElementById("canvas3dWrap");
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

    (function animate() {
      requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    })();
  }

  function loadGLB(url) {
    if (!g3d.loader) return;
    if (g3d.model) {
      g3d.scene.remove(g3d.model);
      g3d.model = null;
    }
    g3d.loader.load(
      url,
      (gltf) => {
        g3d.model = gltf.scene;
        g3d.scene.add(g3d.model);
        const box = new g3d.THREE.Box3().setFromObject(g3d.model);
        const size = box.getSize(new g3d.THREE.Vector3()).length() || 5;
        const center = box.getCenter(new g3d.THREE.Vector3());
        g3d.controls.target.copy(center);
        g3d.camera.position.copy(center).add(new g3d.THREE.Vector3(size * 0.6, size * 0.6, size * 0.6));
        g3d.camera.near = size / 100;
        g3d.camera.far = size * 100;
        g3d.camera.updateProjectionMatrix();
      },
      undefined,
      (err) => console.error("GLB load failed:", err)
    );
  }

  return { init, loadGLB };
}
