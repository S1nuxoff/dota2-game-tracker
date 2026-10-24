// The page exporters/previews.js drives in headless Chrome: window.render(url, gz) draws one model
// of dota2-models as the download site's cards show it (a three-quarter view from the front, the
// model in its first idle pose, on a transparent background) and returns it as a WebP data URL,
// or null for a model with nothing to draw.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const SIZE = Number(new URLSearchParams(location.search).get("size")) || 320;

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(SIZE, SIZE);
renderer.setClearColor(0x000000, 0);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;
const camera = new THREE.PerspectiveCamera(30, 1, 1, 10000);
const key = new THREE.DirectionalLight(0xfff4e8, 2.4);
const rim = new THREE.DirectionalLight(0x9fb8ff, 1.6);
scene.add(key, key.target, rim, new THREE.HemisphereLight(0xdfe6ff, 0x2a2420, 0.6));
const loader = new GLTFLoader();

const idleOf = (names) =>
  names.find((n) => n.toLowerCase() === "idle") ||
  names.find((n) => /^[a-z]+_idle$/i.test(n) && !/loadout/i.test(n)) ||
  names.find((n) => /idle/i.test(n) && !/injured|rare|alt|loadout|\d/i.test(n)) ||
  names.find((n) => /idle/i.test(n)) ||
  "";

function dispose(root) {
  root.traverse((o) => {
    o.geometry?.dispose();
    for (const m of [].concat(o.material || [])) {
      for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
      m.dispose();
    }
  });
}

window.render = async (url, gz) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status}`);
  const body = gz ? res.body.pipeThrough(new DecompressionStream("gzip")) : res.body;
  const gltf = await loader.parseAsync(await new Response(body).arrayBuffer(), "");
  const root = gltf.scene;
  scene.add(root);
  try {
    const idle = idleOf(gltf.animations.map((c) => c.name));
    if (idle) {
      const mixer = new THREE.AnimationMixer(root);
      mixer.clipAction(gltf.animations.find((c) => c.name === idle)).play();
      mixer.update(0);
    }
    root.traverse((o) => o.isMesh && (o.frustumCulled = false));
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root, true);
    if (box.isEmpty()) return null;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    if (!(sphere.radius > 0) || !Number.isFinite(sphere.radius)) return null;

    // The whole model in view from the front, a little to the left and above, filling the picture:
    // from far along that direction, the box's corners in view space give how much nearer the camera
    // can come; the view is centred on the corners' extent, then fitted again
    const { center, radius } = sphere;
    const dir = new THREE.Vector3(0.55, 0.32, 1).normalize();
    const t = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 0.9;
    const corners = [];
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z));
    let target = center.clone();
    let distance = radius * 4;
    for (let pass = 0; pass < 3; pass++) {
      camera.position.copy(target).addScaledVector(dir, distance);
      camera.lookAt(target);
      camera.updateMatrixWorld(true);
      const view = corners.map((c) => c.clone().applyMatrix4(camera.matrixWorldInverse));
      const xs = view.map((v) => v.x);
      const ys = view.map((v) => v.y);
      // Centre: move the target across the view by the middle of the corners' extent
      const midX = (Math.min(...xs) + Math.max(...xs)) / 2;
      const midY = (Math.min(...ys) + Math.max(...ys)) / 2;
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
      target.addScaledVector(right, midX).addScaledVector(up, midY);
      // Nearest distance at which every corner is inside the frame
      let delta = -Infinity;
      for (const v of view) delta = Math.max(delta, Math.max(Math.abs(v.x - midX), Math.abs(v.y - midY)) / t + v.z);
      distance = Math.max(distance + delta, radius * 0.05);
    }
    camera.position.copy(target).addScaledVector(dir, distance);
    camera.near = Math.max(distance - radius * 2, distance / 1000);
    camera.far = distance + radius * 2;
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    key.position.set(center.x - radius * 2, center.y + radius * 2.5, center.z + radius * 2.5);
    key.target.position.copy(center);
    rim.position.set(center.x + radius * 2, center.y + radius, center.z - radius * 3);
    renderer.render(scene, camera);
    return renderer.domElement.toDataURL("image/webp", 0.85);
  } finally {
    scene.remove(root);
    dispose(root);
  }
};
window.ready = true;
