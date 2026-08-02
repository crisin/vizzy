// Shared glTF/GLB/ZIP loading (used by the model scene and the library
// thumbnail generator) plus offscreen thumbnail rendering.

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { unzipSync } from "fflate";

/**
 * Load a model from raw bytes. Accepts .glb, .gltf (embedded) and .zip
 * archives (e.g. Sketchfab downloads: scene.gltf + scene.bin + textures/);
 * zip resources are resolved through blob URLs.
 */
export function loadModelObject(
  data: ArrayBuffer,
  name: string,
): Promise<THREE.Group> {
  const bytes = new Uint8Array(data);
  const isZip =
    name.toLowerCase().endsWith(".zip") ||
    (bytes.length > 1 && bytes[0] === 0x50 && bytes[1] === 0x4b);

  if (!isZip) {
    return parseGltf(data, undefined, null);
  }

  const files = unzipSync(bytes);
  const names = Object.keys(files).filter((n) => !n.endsWith("/"));
  const entry =
    names.find((n) => n.toLowerCase().endsWith(".glb")) ??
    names.find((n) => n.toLowerCase().endsWith(".gltf"));
  if (!entry) {
    return Promise.reject(new Error("kein .glb/.gltf im ZIP"));
  }

  const urls = new Map<string, string>();
  for (const n of names) {
    urls.set(n, URL.createObjectURL(new Blob([files[n] as BlobPart])));
  }
  const baseDir = entry.includes("/")
    ? entry.slice(0, entry.lastIndexOf("/") + 1)
    : "";

  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (
      url.startsWith("blob:") ||
      url.startsWith("data:") ||
      url.includes("/draco/")
    ) {
      return url;
    }
    const clean = decodeURIComponent(url).replace(/^\.\//, "");
    const direct = urls.get(clean) ?? urls.get(baseDir + clean);
    if (direct) return direct;
    const base = clean.split("/").pop() ?? clean;
    for (const [n, u] of urls) {
      if (n === base || n.endsWith("/" + base)) return u;
    }
    return url;
  });

  const cleanup = () => {
    for (const u of urls.values()) URL.revokeObjectURL(u);
  };
  const entryBytes = files[entry];
  const payload: ArrayBuffer | string = entry.toLowerCase().endsWith(".glb")
    ? (entryBytes.buffer.slice(
        entryBytes.byteOffset,
        entryBytes.byteOffset + entryBytes.byteLength,
      ) as ArrayBuffer)
    : new TextDecoder().decode(entryBytes);
  return parseGltf(payload, manager, cleanup);
}

function parseGltf(
  data: ArrayBuffer | string,
  manager: THREE.LoadingManager | undefined,
  cleanup: (() => void) | null,
): Promise<THREE.Group> {
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader(manager);
    const draco = new DRACOLoader(manager);
    draco.setDecoderPath("/draco/");
    loader.setDRACOLoader(draco);
    const done = () => {
      cleanup?.();
      draco.dispose();
    };
    loader.parse(
      data as ArrayBuffer,
      "",
      (gltf) => {
        done();
        resolve(gltf.scene);
      },
      (err) => {
        done();
        reject(err);
      },
    );
  });
}

/** Center an object and scale it so its largest dimension is `fit` units. */
export function centerAndScale(
  obj: THREE.Object3D,
  fit: number,
): { scale: number; maxDim: number } {
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  obj.position.sub(center);
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  return { scale: fit / maxDim, maxDim };
}

/** Render a one-off thumbnail of the object into a data URL. */
export function renderModelThumb(obj: THREE.Object3D, size = 220): string {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  renderer.setClearColor(0x0b0e18, 1);

  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0x8899bb, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(2, 3, 4);
  scene.add(key);
  const rim = new THREE.PointLight(0x38bdf8, 8, 0, 1.8);
  rim.position.set(-3, 1, -2);
  scene.add(rim);

  const wrapper = new THREE.Group();
  const { scale } = centerAndScale(obj, 2);
  wrapper.add(obj);
  wrapper.scale.setScalar(scale);
  wrapper.rotation.y = 0.6;
  scene.add(wrapper);

  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.set(0, 0.8, 3.4);
  camera.lookAt(0, 0, 0);

  renderer.render(scene, camera);
  const url = canvas.toDataURL("image/png");
  renderer.dispose();
  return url;
}
