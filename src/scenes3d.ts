import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { params } from "./params";
import { centerAndScale, loadModelObject } from "./modelLoader";

export interface AudioFrame3D {
  disp: Float32Array; // smoothed bands 0..1
  wave: Float32Array;
  rms: number;
  beat: number; // beat envelope 0..1
  dt: number;
  t: number;
  /** false while the user has grabbed the camera — scenes must not move it */
  cameraAuto: boolean;
}

export type SceneName =
  | "orb"
  | "terrain"
  | "tunnel"
  | "bars3d"
  | "gyro"
  | "blob"
  | "cubes"
  | "critters"
  | "surf"
  | "model";
export const SCENE_NAMES: SceneName[] = [
  "orb",
  "terrain",
  "tunnel",
  "bars3d",
  "gyro",
  "blob",
  "cubes",
  "critters",
  "surf",
  "model",
];

const BG = 0x07070c;
const NUM_BANDS = 64;

interface Scene3D {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** orbit-controls pivot; origin if unset */
  cameraTarget?: THREE.Vector3;
  update(frame: AudioFrame3D): void;
  dispose(): void;
}

/** 4096 additive glow particles on a sphere; bands displace their ring. */
class OrbScene implements Scene3D {
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  private points: THREE.Points;
  private material: THREE.ShaderMaterial;
  private dpr: number;

  constructor(aspect: number, dpr: number) {
    this.dpr = dpr;
    this.camera = new THREE.PerspectiveCamera(60, aspect, 0.1, 100);
    this.camera.position.set(0, 0, 3.4);

    const n = 4096;
    const positions = new Float32Array(n * 3);
    const band = new Float32Array(n);
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) {
      const y = 1 - (i / (n - 1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = golden * i;
      positions[i * 3] = Math.cos(theta) * r;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = Math.sin(theta) * r;
      // bass belt at the equator, treble toward the poles
      band[i] = Math.min(NUM_BANDS - 1, Math.floor(Math.abs(y) * NUM_BANDS));
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("band", new THREE.BufferAttribute(band, 1));

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uBands: { value: new Float32Array(NUM_BANDS) },
        uBeat: { value: 0 },
        uSize: { value: 3.0 * dpr },
        uDisplace: { value: 0.65 },
      },
      vertexShader: /* glsl */ `
        attribute float band;
        uniform float uBands[${NUM_BANDS}];
        uniform float uBeat;
        uniform float uSize;
        uniform float uDisplace;
        varying float vVal;
        varying float vBand;
        void main() {
          float v = uBands[int(band)];
          vec3 p = position * (1.0 + v * uDisplace + uBeat * 0.1);
          vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          gl_PointSize = uSize * (0.6 + v * 2.4) * (3.0 / -mvPosition.z);
          vVal = v;
          vBand = band / ${NUM_BANDS - 1}.0;
        }
      `,
      fragmentShader: /* glsl */ `
        precision mediump float;
        varying float vVal;
        varying float vBand;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          if (d > 0.5) discard;
          float a = smoothstep(0.5, 0.05, d) * (0.18 + vVal * 0.82);
          vec3 cLow = vec3(0.22, 0.83, 0.97);
          vec3 cHigh = vec3(0.98, 0.44, 0.62);
          vec3 c = mix(cLow, cHigh, vBand) * (0.55 + vVal * 1.2);
          gl_FragColor = vec4(c, a);
        }
      `,
    });

    this.points = new THREE.Points(geometry, this.material);
    this.scene.add(this.points);
  }

  update(frame: AudioFrame3D) {
    const u = this.material.uniforms;
    (u.uBands.value as Float32Array).set(frame.disp);
    u.uBeat.value = frame.beat;
    u.uSize.value = params.get("orb", "size") * this.dpr;
    u.uDisplace.value = params.get("orb", "displace");
    const speed = params.get("orb", "speed");
    const kick = params.get("orb", "kick");
    this.points.rotation.y += frame.dt * (speed + frame.beat * kick);
    this.points.rotation.x = 0.25 + Math.sin(frame.t * 0.11) * 0.15;
  }

  dispose() {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}

/** Shared scrolling spectrogram height-field (terrain + surf scenes). */
class SpectroTerrain {
  mesh: THREE.Mesh;
  hScale = 16; // last applied height scale, for sampling world heights
  readonly cols = NUM_BANDS;
  readonly rows = 96;
  readonly width = 64;
  readonly depth = 100;
  private geometry: THREE.PlaneGeometry;
  private material: THREE.MeshBasicMaterial;
  private heights: Float32Array;
  private rowAcc = 0;
  private color = new THREE.Color();

  constructor() {
    this.heights = new Float32Array(this.rows * this.cols);
    this.geometry = new THREE.PlaneGeometry(
      this.width,
      this.depth,
      this.cols - 1,
      this.rows - 1,
    );
    this.geometry.rotateX(-Math.PI / 2);
    this.geometry.setAttribute(
      "color",
      new THREE.BufferAttribute(new Float32Array(this.cols * this.rows * 3), 3),
    );
    this.material = new THREE.MeshBasicMaterial({
      wireframe: true,
      vertexColors: true,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
  }

  update(frame: AudioFrame3D, rowsPerSecond: number, heightScale: number) {
    this.hScale = heightScale;
    const { cols, rows, heights } = this;

    // time-based flow: shift N rows toward the camera this frame
    this.rowAcc += frame.dt * rowsPerSecond;
    let steps = Math.floor(this.rowAcc);
    this.rowAcc -= steps;
    steps = Math.min(steps, 4);
    for (let s = 0; s < steps; s++) {
      heights.copyWithin(cols, 0, (rows - 1) * cols);
      for (let c = 0; c < cols; c++) {
        heights[c] = frame.disp[c] ?? 0;
      }
    }

    const pos = this.geometry.getAttribute("position") as THREE.BufferAttribute;
    const col = this.geometry.getAttribute("color") as THREE.BufferAttribute;
    for (let i = 0; i < heights.length; i++) {
      const h = heights[i];
      pos.setY(i, h * heightScale);
      this.color.setHSL(0.72 - h * 0.45, 0.85, 0.22 + h * 0.5);
      col.setXYZ(i, this.color.r, this.color.g, this.color.b);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }

  /** raw height 0..1 at integer grid coords (clamped) */
  h(colIdx: number, rowIdx: number): number {
    const c = Math.min(this.cols - 1, Math.max(0, colIdx));
    const r = Math.min(this.rows - 1, Math.max(0, rowIdx));
    return this.heights[r * this.cols + c];
  }

  colX(c: number): number {
    return -this.width / 2 + (c / (this.cols - 1)) * this.width;
  }

  rowZ(r: number): number {
    return -this.depth / 2 + (r / (this.rows - 1)) * this.depth;
  }

  get rowSpacing(): number {
    return this.depth / (this.rows - 1);
  }

  get colSpacing(): number {
    return this.width / (this.cols - 1);
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/** Scrolling spectrogram mountains: rows of band history flow toward the camera. */
class TerrainScene implements Scene3D {
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  cameraTarget = new THREE.Vector3(0, 2, -20);
  private terrain = new SpectroTerrain();

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(70, aspect, 0.1, 200);
    this.camera.position.set(0, 15, 52);
    this.camera.lookAt(this.cameraTarget);
    this.scene.fog = new THREE.Fog(BG, 35, 95);
    this.scene.add(this.terrain.mesh);
  }

  update(frame: AudioFrame3D) {
    this.terrain.update(
      frame,
      params.get("terrain", "speed"),
      params.get("terrain", "height") * (1 + frame.beat * 0.2),
    );
    if (frame.cameraAuto) {
      const sway = params.get("terrain", "sway");
      this.camera.position.x = Math.sin(frame.t * 0.1) * sway;
      this.camera.lookAt(this.cameraTarget);
    }
  }

  dispose() {
    this.terrain.dispose();
  }
}

/** Fly through rings whose shape is a spectrum snapshot from when they spawned. */
class TunnelScene implements Scene3D {
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  cameraTarget = new THREE.Vector3(0, 0, -26);
  private rings: THREE.LineLoop[] = [];
  private materials: THREE.LineBasicMaterial[] = [];
  private ringCounter = 0;
  private color = new THREE.Color();
  private readonly nRings = 26;
  private readonly segs = 96;
  private readonly depth = 130;
  private readonly baseRadius = 9;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(74, aspect, 0.1, 200);
    this.camera.position.set(0, 0, 4);
    this.scene.fog = new THREE.Fog(BG, 15, this.depth * 0.9);

    for (let i = 0; i < this.nRings; i++) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(this.segs * 3), 3),
      );
      const material = new THREE.LineBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.85,
        fog: true,
      });
      const ring = new THREE.LineLoop(geometry, material);
      ring.position.z = -((i / this.nRings) * this.depth);
      this.rings.push(ring);
      this.materials.push(material);
      this.scene.add(ring);
      this.shapeRing(ring, material, null); // start as plain circles
    }
  }

  /** Bake the current spectrum (or a flat circle) into a ring's geometry. */
  private shapeRing(
    ring: THREE.LineLoop,
    material: THREE.LineBasicMaterial,
    disp: Float32Array | null,
  ) {
    const pos = ring.geometry.getAttribute("position") as THREE.BufferAttribute;
    let energy = 0;
    for (let s = 0; s < this.segs; s++) {
      const angle = (s / this.segs) * Math.PI * 2;
      // mirror the spectrum around the vertical axis
      const half = this.segs / 2;
      const m = s < half ? s : this.segs - s;
      const bandIdx = Math.min(
        NUM_BANDS - 1,
        Math.floor((m / half) * NUM_BANDS),
      );
      const v = disp ? disp[bandIdx] : 0;
      energy += v;
      const r = this.baseRadius * (1 + v * 0.55);
      pos.setXYZ(s, Math.cos(angle) * r, Math.sin(angle) * r, 0);
    }
    pos.needsUpdate = true;
    energy /= this.segs;

    this.ringCounter += 1;
    ring.rotation.z = this.ringCounter * params.get("tunnel", "twist") * Math.PI;
    const hue = (0.55 + this.ringCounter * 0.013) % 1;
    this.color.setHSL(hue, 0.85, 0.45 + energy * 0.35);
    material.color.copy(this.color);
    material.opacity = 0.5 + energy * 0.5;
  }

  update(frame: AudioFrame3D) {
    const speed = params.get("tunnel", "speed");
    const pulse = params.get("tunnel", "pulse");
    const dz = (speed * (1 + frame.beat * pulse)) * frame.dt;
    for (let i = 0; i < this.rings.length; i++) {
      const ring = this.rings[i];
      ring.position.z += dz;
      if (ring.position.z > this.camera.position.z + 2) {
        ring.position.z -= this.depth;
        this.shapeRing(ring, this.materials[i], frame.disp);
      }
    }
    if (frame.cameraAuto) {
      this.camera.position.x = Math.sin(frame.t * 0.6) * 0.6;
      this.camera.position.y = Math.cos(frame.t * 0.45) * 0.5;
      this.camera.lookAt(0, 0, this.camera.position.z - 30);
    }
  }

  dispose() {
    for (const ring of this.rings) {
      ring.geometry.dispose();
    }
    for (const material of this.materials) {
      material.dispose();
    }
  }
}

/** The classic EQ, but as a ring of 3D bars with an orbiting camera. */
class Bars3DScene implements Scene3D {
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  cameraTarget = new THREE.Vector3(0, 2.5, 0);
  private bars: THREE.InstancedMesh;
  private grid: THREE.GridHelper;
  private dummy = new THREE.Object3D();
  private color = new THREE.Color();

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(60, aspect, 0.1, 100);
    this.scene.fog = new THREE.Fog(BG, 18, 48);

    const geometry = new THREE.BoxGeometry(0.6, 1, 0.6);
    geometry.translate(0, 0.5, 0); // bars grow up from the floor
    this.bars = new THREE.InstancedMesh(
      geometry,
      new THREE.MeshBasicMaterial(),
      NUM_BANDS,
    );
    this.scene.add(this.bars);

    this.grid = new THREE.GridHelper(44, 44, 0x1e293b, 0x131c30);
    this.scene.add(this.grid);
  }

  update(frame: AudioFrame3D) {
    const height = params.get("bars3d", "height");
    const orbit = params.get("bars3d", "orbit");
    for (let i = 0; i < NUM_BANDS; i++) {
      const v = frame.disp[i] ?? 0;
      const angle = (i / NUM_BANDS) * Math.PI * 2;
      this.dummy.position.set(Math.cos(angle) * 8, 0, Math.sin(angle) * 8);
      this.dummy.rotation.set(0, -angle, 0);
      this.dummy.scale.set(1, Math.max(0.05, v * height), 1);
      this.dummy.updateMatrix();
      this.bars.setMatrixAt(i, this.dummy.matrix);
      this.color.setHSL(0.55 + (i / NUM_BANDS) * 0.35, 0.9, 0.22 + v * 0.5);
      this.bars.setColorAt(i, this.color);
    }
    this.bars.instanceMatrix.needsUpdate = true;
    if (this.bars.instanceColor) this.bars.instanceColor.needsUpdate = true;

    if (frame.cameraAuto) {
      const a = frame.t * orbit;
      this.camera.position.set(
        Math.sin(a) * 16,
        6 + Math.sin(frame.t * 0.3) * 2 + frame.beat * 0.8,
        Math.cos(a) * 16,
      );
      this.camera.lookAt(0, 2.5, 0);
    }
  }

  dispose() {
    this.bars.geometry.dispose();
    (this.bars.material as THREE.Material).dispose();
    this.grid.geometry.dispose();
    (this.grid.material as THREE.Material).dispose();
  }
}

/** Nested glowing rings spinning on different axes, one band group each. */
class GyroScene implements Scene3D {
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  private rings: THREE.Mesh[] = [];
  private materials: THREE.MeshBasicMaterial[] = [];
  private color = new THREE.Color();
  private readonly count = 6;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(60, aspect, 0.1, 100);
    this.camera.position.set(0, 0, 7.5);

    for (let i = 0; i < this.count; i++) {
      const geometry = new THREE.TorusGeometry(1 + i * 0.55, 0.025, 12, 128);
      const material = new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0.7,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const ring = new THREE.Mesh(geometry, material);
      ring.rotation.set(i * 0.7, i * 1.3, 0);
      this.rings.push(ring);
      this.materials.push(material);
      this.scene.add(ring);
    }
  }

  update(frame: AudioFrame3D) {
    const speed = params.get("gyro", "speed");
    const kick = params.get("gyro", "kick");
    const per = Math.floor(NUM_BANDS / this.count);
    for (let i = 0; i < this.count; i++) {
      // average of this ring's band group
      let g = 0;
      for (let b = i * per; b < (i + 1) * per; b++) {
        g += frame.disp[b] ?? 0;
      }
      g /= per;

      const ring = this.rings[i];
      const dir = i % 2 === 0 ? 1 : -1;
      const w = frame.dt * (speed * (0.5 + i * 0.22) + frame.beat * kick);
      ring.rotation.x += w * dir;
      ring.rotation.y += w * 0.8;
      ring.scale.setScalar(1 + g * 0.3 + frame.beat * 0.05);

      this.color.setHSL((0.52 + i * 0.07 + g * 0.08) % 1, 0.9, 0.4 + g * 0.35);
      this.materials[i].color.copy(this.color);
      this.materials[i].opacity = 0.3 + g * 0.7;
    }
    if (frame.cameraAuto) {
      this.camera.position.x = Math.sin(frame.t * 0.25) * 1.2;
      this.camera.position.y = Math.cos(frame.t * 0.2) * 0.8;
      this.camera.lookAt(0, 0, 0);
    }
  }

  dispose() {
    for (const ring of this.rings) {
      ring.geometry.dispose();
    }
    for (const material of this.materials) {
      material.dispose();
    }
  }
}

/** Nested wireframe cubes tumbling through each other, one band group each. */
class CubesScene implements Scene3D {
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  private cubes: THREE.LineSegments[] = [];
  private materials: THREE.LineBasicMaterial[] = [];
  private core: THREE.Mesh;
  private coreMaterial: THREE.MeshBasicMaterial;
  private color = new THREE.Color();
  private readonly count = 6;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(60, aspect, 0.1, 100);
    this.camera.position.set(0, 0, 8.5);

    for (let i = 0; i < this.count; i++) {
      const geometry = new THREE.BoxGeometry(1, 1, 1);
      const edges = new THREE.EdgesGeometry(geometry);
      geometry.dispose();
      const material = new THREE.LineBasicMaterial({
        transparent: true,
        opacity: 0.8,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const cube = new THREE.LineSegments(edges, material);
      cube.rotation.set(i * 0.6, i * 1.1, i * 0.35);
      this.cubes.push(cube);
      this.materials.push(material);
      this.scene.add(cube);
    }

    // pulsing translucent core
    this.coreMaterial = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.12,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.core = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.coreMaterial);
    this.scene.add(this.core);
  }

  update(frame: AudioFrame3D) {
    const speed = params.get("cubes", "speed");
    const spread = params.get("cubes", "spread");
    const kick = params.get("cubes", "kick");
    const per = Math.floor(NUM_BANDS / this.count);

    let bass = 0;
    for (let b = 0; b < 8; b++) bass += frame.disp[b] ?? 0;
    bass /= 8;

    for (let i = 0; i < this.count; i++) {
      let g = 0;
      for (let b = i * per; b < (i + 1) * per; b++) {
        g += frame.disp[b] ?? 0;
      }
      g /= per;

      const cube = this.cubes[i];
      const dir = i % 2 === 0 ? 1 : -1;
      const w = frame.dt * (speed * (0.35 + i * 0.16) + frame.beat * kick);
      cube.rotation.x += w * dir;
      cube.rotation.y += w * 0.75;
      cube.rotation.z += w * 0.35 * dir;
      const size = 1.1 * Math.pow(spread, i);
      cube.scale.setScalar(size * (1 + g * 0.3 + frame.beat * 0.06));

      this.color.setHSL((0.55 + i * 0.06 + g * 0.1) % 1, 0.9, 0.4 + g * 0.35);
      this.materials[i].color.copy(this.color);
      this.materials[i].opacity = 0.35 + g * 0.65;
    }

    this.core.rotation.x -= frame.dt * speed * 0.4;
    this.core.rotation.y += frame.dt * speed * 0.55;
    this.core.scale.setScalar(0.9 * (1 + bass * 0.5 + frame.beat * 0.15));
    this.coreMaterial.opacity = 0.06 + bass * 0.3;

    if (frame.cameraAuto) {
      this.camera.position.x = Math.sin(frame.t * 0.2) * 2;
      this.camera.position.y = Math.cos(frame.t * 0.16) * 1.4;
      this.camera.lookAt(0, 0, 0);
    }
  }

  dispose() {
    for (const cube of this.cubes) cube.geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.core.geometry.dispose();
    this.coreMaterial.dispose();
  }
}

// ————— shared blocky critter rigs (critters + surf scenes) —————

interface CritterRig {
  root: THREE.Group; // move/tilt this
  body: THREE.Group; // squash & stretch target
  head: THREE.Group; // nod target
  ears: THREE.Mesh[]; // treble wiggle
  tail: THREE.Mesh | null;
}

function critterBox(
  parent: THREE.Object3D,
  w: number,
  h: number,
  d: number,
  color: number,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color, roughness: 0.85, flatShading: true }),
  );
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
}

function buildBunnyRig(): CritterRig {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  critterBox(body, 0.85, 0.7, 1.05, 0xe8e4de, 0, 0.55, 0); // torso
  critterBox(body, 0.3, 0.2, 0.3, 0xffffff, 0, 0.7, -0.62); // fluffy tail
  critterBox(body, 0.28, 0.22, 0.42, 0xd9d4cc, -0.28, 0.15, 0.3); // paw
  critterBox(body, 0.28, 0.22, 0.42, 0xd9d4cc, 0.28, 0.15, 0.3); // paw
  const head = new THREE.Group();
  head.position.set(0, 1.05, 0.45);
  body.add(head);
  critterBox(head, 0.55, 0.52, 0.5, 0xefebe4, 0, 0, 0);
  critterBox(head, 0.1, 0.1, 0.08, 0xff9db3, 0, -0.08, 0.28); // nose
  const earL = critterBox(head, 0.14, 0.65, 0.18, 0xefebe4, -0.16, 0.5, -0.05);
  const earR = critterBox(head, 0.14, 0.65, 0.18, 0xefebe4, 0.16, 0.5, -0.05);
  return { root, body, head, ears: [earL, earR], tail: null };
}

function buildCowRig(): CritterRig {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  critterBox(body, 1.35, 0.85, 1.8, 0xf2efe9, 0, 0.95, 0); // torso
  critterBox(body, 0.55, 0.5, 0.6, 0x2e2a26, -0.35, 1.0, -0.4); // patch
  critterBox(body, 0.45, 0.4, 0.5, 0x2e2a26, 0.4, 1.15, 0.35); // patch
  for (const [lx, lz] of [
    [-0.45, 0.6],
    [0.45, 0.6],
    [-0.45, -0.6],
    [0.45, -0.6],
  ] as const) {
    critterBox(body, 0.26, 0.55, 0.26, 0xe8e4de, lx, 0.28, lz);
  }
  const head = new THREE.Group();
  head.position.set(0, 1.45, 1.05);
  body.add(head);
  critterBox(head, 0.6, 0.55, 0.5, 0xf2efe9, 0, 0, 0);
  critterBox(head, 0.42, 0.25, 0.18, 0xf5b8c4, 0, -0.18, 0.3); // snout
  critterBox(head, 0.16, 0.16, 0.14, 0xd9d4cc, -0.4, 0.22, 0); // horn
  critterBox(head, 0.16, 0.16, 0.14, 0xd9d4cc, 0.4, 0.22, 0);
  return { root, body, head, ears: [], tail: null };
}

function buildPigRig(): CritterRig {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  critterBox(body, 0.95, 0.68, 1.25, 0xf7a8b8, 0, 0.55, 0); // torso
  for (const [lx, lz] of [
    [-0.3, 0.4],
    [0.3, 0.4],
    [-0.3, -0.4],
    [0.3, -0.4],
  ] as const) {
    critterBox(body, 0.2, 0.32, 0.2, 0xeb96a8, lx, 0.12, lz);
  }
  const tail = critterBox(body, 0.1, 0.1, 0.28, 0xeb96a8, 0, 0.75, -0.7);
  const head = new THREE.Group();
  head.position.set(0, 0.85, 0.72);
  body.add(head);
  critterBox(head, 0.52, 0.48, 0.42, 0xf7a8b8, 0, 0, 0);
  critterBox(head, 0.26, 0.2, 0.14, 0xeb96a8, 0, -0.05, 0.27); // snout
  critterBox(head, 0.14, 0.18, 0.08, 0xeb96a8, -0.17, 0.3, 0); // ear
  critterBox(head, 0.14, 0.18, 0.08, 0xeb96a8, 0.17, 0.3, 0);
  return { root, body, head, ears: [], tail };
}

function disposeTree(root: THREE.Object3D) {
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if ((mesh as { isMesh?: boolean }).isMesh) {
      mesh.geometry.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) m?.dispose?.();
    }
  });
}

/** Blocky low-poly critters (bunny, cow, pig) bouncing to the music. */
class CrittersScene implements Scene3D {
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  cameraTarget = new THREE.Vector3(0, 1, 0);
  private stage = new THREE.Group();
  private grid: THREE.GridHelper;
  private discoLight: THREE.PointLight;
  private rigs: CritterRig[];

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(50, aspect, 0.1, 100);
    this.camera.position.set(0, 2.4, 7.5);
    this.camera.lookAt(this.cameraTarget);
    this.scene.fog = new THREE.Fog(BG, 14, 40);

    this.scene.add(new THREE.AmbientLight(0x445066, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(3, 6, 4);
    this.scene.add(sun);
    this.discoLight = new THREE.PointLight(0x38bdf8, 20, 0, 1.8);
    this.discoLight.position.set(0, 4, 2);
    this.scene.add(this.discoLight);

    this.grid = new THREE.GridHelper(30, 30, 0x1e293b, 0x131c30);
    this.scene.add(this.grid);
    this.scene.add(this.stage);

    this.rigs = [buildBunnyRig(), buildCowRig(), buildPigRig()];
    this.rigs[0].root.position.x = -2.4;
    this.rigs[2].root.position.x = 2.4;
    for (const rig of this.rigs) this.stage.add(rig.root);
  }

  update(frame: AudioFrame3D) {
    const bounce = params.get("critters", "bounce");
    const wiggle = params.get("critters", "wiggle");
    const spin = params.get("critters", "spin");

    const avg = (from: number, to: number) => {
      let s = 0;
      for (let i = from; i < to; i++) s += frame.disp[i] ?? 0;
      return s / (to - from);
    };
    const bass = avg(0, 8);
    const mids = avg(16, 32);
    const treble = avg(40, 56);

    // squash & stretch on the bass, offset per critter so they groove
    for (let i = 0; i < this.rigs.length; i++) {
      const rig = this.rigs[i];
      const phase = 1 + 0.15 * Math.sin(frame.t * 2 + i * 2.1);
      const squash = 1 + bass * bounce * 0.35 * phase + frame.beat * 0.08;
      rig.body.scale.set(1 / Math.sqrt(squash), squash, 1 / Math.sqrt(squash));
      rig.head.rotation.x = -frame.beat * 0.45 * bounce;
    }

    // bunny hops on beats
    this.rigs[0].root.position.y = Math.pow(frame.beat, 2) * 0.9 * bounce;

    // ears, cow headbang, pig tail wag on treble/mids
    const w = Math.sin(frame.t * 11) * treble * wiggle;
    this.rigs[0].ears[0].rotation.z = 0.15 + w * 0.8;
    this.rigs[0].ears[1].rotation.z = -0.15 - w * 0.8;
    this.rigs[1].head.rotation.z = Math.sin(frame.t * 5.3) * mids * wiggle * 0.5;
    if (this.rigs[2].tail) {
      this.rigs[2].tail.rotation.y =
        Math.sin(frame.t * 13) * (0.2 + treble * wiggle);
    }

    this.stage.rotation.y += frame.dt * spin;
    this.discoLight.intensity = 6 + bass * 40;
    this.discoLight.color.setHSL((frame.t * 0.06) % 1, 0.8, 0.6);

    if (frame.cameraAuto) {
      this.camera.position.x = Math.sin(frame.t * 0.12) * 2.2;
      this.camera.lookAt(this.cameraTarget);
    }
  }

  dispose() {
    disposeTree(this.stage);
    this.grid.geometry.dispose();
    (this.grid.material as THREE.Material).dispose();
  }
}

/** The critters surfing the spectrogram waves on glowing boards. */
class SurfScene implements Scene3D {
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  cameraTarget = new THREE.Vector3(0, 6, 10);
  private terrain = new SpectroTerrain();
  private discoLight: THREE.PointLight;
  private riders: {
    rig: CritterRig;
    group: THREE.Group;
    col: number;
    row: number;
    tiltX: number;
    tiltZ: number;
  }[] = [];

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(62, aspect, 0.1, 200);
    this.camera.position.set(0, 13, 55);
    this.camera.lookAt(this.cameraTarget);
    this.scene.fog = new THREE.Fog(BG, 40, 100);

    this.scene.add(this.terrain.mesh);
    this.scene.add(new THREE.AmbientLight(0x445066, 1.7));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(4, 10, 6);
    this.scene.add(sun);
    this.discoLight = new THREE.PointLight(0x38bdf8, 30, 0, 1.6);
    this.discoLight.position.set(0, 18, 30);
    this.scene.add(this.discoLight);

    const boards = [0x38bdf8, 0xa78bfa, 0xf472b6];
    const rigs = [buildBunnyRig(), buildCowRig(), buildPigRig()];
    const cols = [16, 32, 48]; // bass / mids / upper-mids lanes
    const row = 76; // near the camera
    for (let i = 0; i < rigs.length; i++) {
      const group = new THREE.Group();
      critterBox(group, 1.9, 0.12, 0.85, boards[i], 0, 0, 0); // surfboard
      rigs[i].root.position.y = 0.08;
      group.add(rigs[i].root);
      group.position.set(this.terrain.colX(cols[i]), 0, this.terrain.rowZ(row));
      this.scene.add(group);
      this.riders.push({
        rig: rigs[i],
        group,
        col: cols[i],
        row,
        tiltX: 0,
        tiltZ: 0,
      });
    }
  }

  update(frame: AudioFrame3D) {
    const height = params.get("surf", "height");
    const speed = params.get("surf", "speed");
    const bounce = params.get("surf", "bounce");
    this.terrain.update(frame, speed, height * (1 + frame.beat * 0.15));

    const avg = (from: number, to: number) => {
      let s = 0;
      for (let i = from; i < to; i++) s += frame.disp[i] ?? 0;
      return s / (to - from);
    };
    const bass = avg(0, 8);
    const treble = avg(40, 56);

    const t = this.terrain;
    const lerp = Math.min(1, frame.dt * 8);
    for (let i = 0; i < this.riders.length; i++) {
      const rider = this.riders[i];
      const { col, row } = rider;
      const h = t.h(col, row) * t.hScale;
      const jump = Math.pow(frame.beat, 2) * bounce * 2.2;
      rider.group.position.y = h + jump;

      // ride the local slope: pitch from the flow direction, roll sideways
      const dhdz = ((t.h(col, row + 1) - t.h(col, row - 1)) * t.hScale) /
        (2 * t.rowSpacing);
      const dhdx = ((t.h(col + 1, row) - t.h(col - 1, row)) * t.hScale) /
        (2 * t.colSpacing);
      rider.tiltX += (Math.atan(dhdz) * 0.7 - rider.tiltX) * lerp;
      rider.tiltZ += (-Math.atan(dhdx) * 0.5 - rider.tiltZ) * lerp;
      rider.group.rotation.x = rider.tiltX;
      rider.group.rotation.z = rider.tiltZ;

      const squash = 1 + bass * bounce * 0.3 + frame.beat * 0.08;
      rider.rig.body.scale.set(
        1 / Math.sqrt(squash),
        squash,
        1 / Math.sqrt(squash),
      );
      rider.rig.head.rotation.x = -frame.beat * 0.4 * bounce;
    }

    // bunny ears + pig tail keep partying while surfing
    const w = Math.sin(frame.t * 11) * treble;
    this.riders[0].rig.ears[0].rotation.z = 0.15 + w * 0.8;
    this.riders[0].rig.ears[1].rotation.z = -0.15 - w * 0.8;
    if (this.riders[2].rig.tail) {
      this.riders[2].rig.tail.rotation.y = Math.sin(frame.t * 13) * (0.2 + treble);
    }

    this.discoLight.intensity = 12 + bass * 60;
    this.discoLight.color.setHSL((frame.t * 0.05) % 1, 0.8, 0.6);

    if (frame.cameraAuto) {
      this.camera.position.x = Math.sin(frame.t * 0.12) * 5;
      this.camera.position.y = 13 + Math.sin(frame.t * 0.2) * 1.5;
      this.camera.lookAt(this.cameraTarget);
    }
  }

  dispose() {
    this.terrain.dispose();
    for (const rider of this.riders) disposeTree(rider.group);
  }
}

// Ashima/webgl-noise simplex 3D (MIT), the standard GLSL implementation.
const SNOISE_GLSL = /* glsl */ `
vec3 mod289(vec3 x){return x - floor(x * (1.0/289.0)) * 289.0;}
vec4 mod289(vec4 x){return x - floor(x * (1.0/289.0)) * 289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314 * r;}
float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
      i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
`;

/** Procedural noise blob: GPU-displaced icosphere, bass drives the shape. */
class BlobScene implements Scene3D {
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  private mesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;
  private time = 0;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(55, aspect, 0.1, 100);
    this.camera.position.set(0, 0, 4);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uAmp: { value: 0.5 },
        uFreq: { value: 2.2 },
        uBass: { value: 0 },
        uMid: { value: 0 },
        uBeat: { value: 0 },
      },
      vertexShader: /* glsl */ `
        ${SNOISE_GLSL}
        uniform float uTime;
        uniform float uAmp;
        uniform float uFreq;
        uniform float uBass;
        uniform float uMid;
        uniform float uBeat;
        varying float vDisp;
        varying vec3 vNormal;
        void main() {
          vec3 dir = normalize(position);
          float n = snoise(dir * uFreq + vec3(0.0, uTime * 0.4, 0.0));
          float n2 = snoise(dir * uFreq * 2.3 - vec3(uTime * 0.7));
          float d = n * (0.35 + uBass * 1.2) + n2 * 0.2 * (0.3 + uMid * 1.6);
          vec3 p = position * (1.0 + d * uAmp + uBeat * 0.07);
          vDisp = d;
          vNormal = normalMatrix * normal;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision mediump float;
        varying float vDisp;
        varying vec3 vNormal;
        void main() {
          float rim = pow(1.0 - abs(normalize(vNormal).z), 2.0);
          vec3 cLow = vec3(0.13, 0.52, 0.96);
          vec3 cHigh = vec3(0.96, 0.30, 0.60);
          vec3 c = mix(cLow, cHigh, clamp(vDisp * 1.4 + 0.5, 0.0, 1.0));
          gl_FragColor = vec4(c * (0.35 + rim * 1.3), 1.0);
        }
      `,
    });

    this.mesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.15, 64),
      this.material,
    );
    this.scene.add(this.mesh);
  }

  update(frame: AudioFrame3D) {
    const avg = (from: number, to: number) => {
      let s = 0;
      for (let i = from; i < to; i++) s += frame.disp[i] ?? 0;
      return s / (to - from);
    };
    this.time += frame.dt * params.get("blob", "speed");
    const u = this.material.uniforms;
    u.uTime.value = this.time;
    u.uAmp.value = params.get("blob", "amp");
    u.uFreq.value = params.get("blob", "freq");
    u.uBass.value = avg(0, 8);
    u.uMid.value = avg(16, 40);
    u.uBeat.value = frame.beat;
    this.mesh.rotation.y += frame.dt * 0.15;
    this.mesh.rotation.z = Math.sin(frame.t * 0.2) * 0.15;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

// Injected into <begin_vertex>: each triangle flies along its face normal
// and tumbles around it, scaled by uExplode (0 = intact model).
const EXPLODE_CHUNK = /* glsl */ `
vec3 transformed = vec3(position);
{
  float amt = uExplode * (0.5 + aRand);
  vec3 axis = normalize(aDir + vec3(0.0001));
  vec3 rel = position - aCentroid;
  float ang = uExplode * (aRand - 0.5) * 8.0;
  float ca = cos(ang);
  float sa = sin(ang);
  rel = rel * ca + cross(axis, rel) * sa + axis * dot(axis, rel) * (1.0 - ca);
  transformed = aCentroid + rel + aDir * amt;
}
`;

/** A user-supplied glTF/GLB model on a stage with band-driven lights. */
class ModelScene implements Scene3D {
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  cameraTarget = new THREE.Vector3(0, 1, 0);
  private holder = new THREE.Group();
  private lights: THREE.PointLight[];
  private grid: THREE.GridHelper;
  private baseScale = 1;
  private explodeScale = 0.5; // world-ish units per full explode, per model
  private explodeUniforms: { value: number }[] = [];
  private log: (msg: string) => void;

  constructor(aspect: number, log: (msg: string) => void) {
    this.log = log;
    this.camera = new THREE.PerspectiveCamera(50, aspect, 0.1, 100);
    this.camera.position.set(0, 1.6, 4.6);
    this.camera.lookAt(0, 1, 0);
    this.scene.fog = new THREE.Fog(BG, 12, 40);

    this.scene.add(new THREE.AmbientLight(0x334155, 1.2));
    this.lights = [
      new THREE.PointLight(0x38bdf8, 1, 0, 1.6), // bass
      new THREE.PointLight(0xa78bfa, 1, 0, 1.6), // mids
      new THREE.PointLight(0xf472b6, 1, 0, 1.6), // treble
    ];
    this.lights[0].position.set(3.5, 2.5, 3);
    this.lights[1].position.set(-3.5, 2.5, -1);
    this.lights[2].position.set(0, 3.5, -3.5);
    for (const l of this.lights) this.scene.add(l);

    this.grid = new THREE.GridHelper(24, 32, 0x1e293b, 0x131c30);
    this.scene.add(this.grid);

    // placeholder until the user loads a model
    const knot = new THREE.Mesh(
      new THREE.TorusKnotGeometry(0.7, 0.22, 160, 24),
      new THREE.MeshStandardMaterial({
        color: 0xcbd5e1,
        metalness: 0.85,
        roughness: 0.25,
      }),
    );
    this.holder.add(knot);
    this.holder.position.y = 1.1;
    this.scene.add(this.holder);
    this.prepareExplode(this.holder);
  }

  /**
   * Split every mesh into independent triangles and attach per-triangle
   * attributes (face normal, centroid, random) so the injected vertex
   * shader can blow the model apart.
   */
  private prepareExplode(root: THREE.Object3D) {
    this.explodeUniforms = [];
    let triangles = 0;
    root.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!(mesh as { isMesh?: boolean }).isMesh) return;

      let geometry = mesh.geometry as THREE.BufferGeometry;
      if (geometry.index) {
        geometry = geometry.toNonIndexed();
        mesh.geometry = geometry;
      }
      const pos = geometry.getAttribute("position");
      const count = pos.count;
      triangles += count / 3;
      const centroids = new Float32Array(count * 3);
      const dirs = new Float32Array(count * 3);
      const rands = new Float32Array(count);

      const a = new THREE.Vector3();
      const b = new THREE.Vector3();
      const c = new THREE.Vector3();
      const n = new THREE.Vector3();
      for (let i = 0; i < count; i += 3) {
        a.fromBufferAttribute(pos, i);
        b.fromBufferAttribute(pos, i + 1);
        c.fromBufferAttribute(pos, i + 2);
        const cx = (a.x + b.x + c.x) / 3;
        const cy = (a.y + b.y + c.y) / 3;
        const cz = (a.z + b.z + c.z) / 3;
        n.subVectors(b, a).cross(c.clone().sub(a));
        if (n.lengthSq() < 1e-12) n.set(0, 1, 0);
        n.normalize();
        const r = Math.random();
        for (let k = 0; k < 3; k++) {
          centroids[(i + k) * 3] = cx;
          centroids[(i + k) * 3 + 1] = cy;
          centroids[(i + k) * 3 + 2] = cz;
          dirs[(i + k) * 3] = n.x;
          dirs[(i + k) * 3 + 1] = n.y;
          dirs[(i + k) * 3 + 2] = n.z;
          rands[i + k] = r;
        }
      }
      geometry.setAttribute("aCentroid", new THREE.BufferAttribute(centroids, 3));
      geometry.setAttribute("aDir", new THREE.BufferAttribute(dirs, 3));
      geometry.setAttribute("aRand", new THREE.BufferAttribute(rands, 1));

      const mats = Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material];
      for (const mat of mats) {
        if (mat) this.patchMaterial(mat);
      }
    });
    this.log(`[3d] explode prepared: ${Math.round(triangles)} triangles`);
  }

  private patchMaterial(mat: THREE.Material) {
    const uExplode = { value: 0 };
    this.explodeUniforms.push(uExplode);
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uExplode = uExplode;
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "#include <common>\nattribute vec3 aCentroid;\nattribute vec3 aDir;\nattribute float aRand;\nuniform float uExplode;",
        )
        .replace("#include <begin_vertex>", EXPLODE_CHUNK);
    };
    mat.needsUpdate = true;
  }

  /** Accepts .glb, .gltf (embedded) and .zip archives (Sketchfab-style). */
  loadModel(data: ArrayBuffer, name: string) {
    loadModelObject(data, name)
      .then((obj) => {
        this.clearHolder();
        const { scale, maxDim } = centerAndScale(obj, 2.4);
        this.baseScale = scale;
        this.explodeScale = maxDim * 0.25;
        this.holder.add(obj);
        this.prepareExplode(obj);
        this.log(`[3d] model loaded: ${name}`);
      })
      .catch((err) => {
        this.log(`[3d] model load FAILED (${name}): ${err}`);
      });
  }

  private clearHolder() {
    for (const child of [...this.holder.children]) {
      this.holder.remove(child);
      child.traverse((node) => {
        const mesh = node as THREE.Mesh;
        mesh.geometry?.dispose?.();
        const mats = Array.isArray(mesh.material)
          ? mesh.material
          : [mesh.material];
        for (const m of mats) m?.dispose?.();
      });
    }
  }

  update(frame: AudioFrame3D) {
    const spin = params.get("model", "spin");
    const pulse = params.get("model", "pulse");
    const light = params.get("model", "light");

    const avg = (from: number, to: number) => {
      let s = 0;
      for (let i = from; i < to; i++) s += frame.disp[i] ?? 0;
      return s / (to - from);
    };
    const bass = avg(0, 8);
    const mids = avg(16, 32);
    const treble = avg(40, 56);

    this.holder.rotation.y += frame.dt * (spin + frame.beat * spin * 2);
    this.holder.scale.setScalar(
      this.baseScale * (1 + bass * pulse * 0.4 + frame.beat * 0.05),
    );
    this.holder.position.y = 1.1 + Math.sin(frame.t * 0.8) * 0.08;

    const explode = params.get("model", "explode");
    const amount =
      explode * (bass * 0.5 + frame.beat * 1.2) * this.explodeScale;
    for (const u of this.explodeUniforms) {
      u.value = amount;
    }

    this.lights[0].intensity = light * (0.4 + bass * 5);
    this.lights[1].intensity = light * (0.4 + mids * 5);
    this.lights[2].intensity = light * (0.4 + treble * 5);
  }

  dispose() {
    this.clearHolder();
    this.grid.geometry.dispose();
    (this.grid.material as THREE.Material).dispose();
  }
}

/** Owns the WebGL renderer on its canvas and the active 3D scene. */
export class Viz3D {
  private renderer: THREE.WebGLRenderer;
  private active: Scene3D;
  private name: SceneName;
  private dpr: number;
  private log: (msg: string) => void;
  private pendingModel: { data: ArrayBuffer; name: string } | null = null;
  private controls: OrbitControls | null = null;
  private homePos = new THREE.Vector3();
  private homeTarget = new THREE.Vector3();
  private userCam = false;
  private onDblClick = () => this.resetCamera();

  constructor(
    canvas: HTMLCanvasElement,
    initial: SceneName = "orb",
    log: (msg: string) => void = console.log,
  ) {
    this.dpr = window.devicePixelRatio || 1;
    this.log = log;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setClearColor(BG, 1);
    this.name = initial;
    this.active = this.create(initial);
    this.setupControls();
    canvas.addEventListener("dblclick", this.onDblClick);
    this.resize(canvas.width, canvas.height);
  }

  /** Mouse camera: drag = orbit, wheel = zoom, right-drag = pan. Grabbing
   * the camera pauses the scene's own camera animation until reset. */
  private setupControls() {
    this.controls?.dispose();
    this.userCam = false;
    const camera = this.active.camera;
    this.homePos.copy(camera.position);
    this.homeTarget.copy(this.active.cameraTarget ?? new THREE.Vector3());
    const controls = new OrbitControls(camera, this.renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 0.5;
    controls.maxDistance = 90;
    controls.target.copy(this.homeTarget);
    controls.addEventListener("start", () => {
      this.userCam = true;
    });
    this.controls = controls;
  }

  /** Back to the scene's automatic camera (double click / HUD button). */
  resetCamera() {
    this.userCam = false;
    this.active.camera.position.copy(this.homePos);
    this.controls?.target.copy(this.homeTarget);
    this.active.camera.lookAt(this.homeTarget);
  }

  get sceneName(): SceneName {
    return this.name;
  }

  private create(name: SceneName): Scene3D {
    const canvas = this.renderer.domElement;
    const aspect = canvas.width / Math.max(1, canvas.height);
    switch (name) {
      case "orb":
        return new OrbScene(aspect, this.dpr);
      case "terrain":
        return new TerrainScene(aspect);
      case "tunnel":
        return new TunnelScene(aspect);
      case "bars3d":
        return new Bars3DScene(aspect);
      case "gyro":
        return new GyroScene(aspect);
      case "blob":
        return new BlobScene(aspect);
      case "cubes":
        return new CubesScene(aspect);
      case "critters":
        return new CrittersScene(aspect);
      case "surf":
        return new SurfScene(aspect);
      case "model": {
        const scene = new ModelScene(aspect, this.log);
        if (this.pendingModel) {
          scene.loadModel(this.pendingModel.data, this.pendingModel.name);
        }
        return scene;
      }
    }
  }

  /** Load a glTF/GLB/ZIP into the model scene (kept for scene switches). */
  loadModel(data: ArrayBuffer, name: string) {
    this.pendingModel = { data, name };
    if (this.active instanceof ModelScene) {
      this.active.loadModel(data, name);
    }
  }

  /** Back to the placeholder (recreates the model scene without a model). */
  clearModel() {
    this.pendingModel = null;
    if (this.active instanceof ModelScene) {
      this.active.dispose();
      this.active = this.create("model");
      this.setupControls();
    }
  }

  setScene(name: SceneName) {
    if (name === this.name) return;
    this.active.dispose();
    this.name = name;
    this.active = this.create(name);
    this.setupControls();
  }

  resize(width: number, height: number) {
    this.renderer.setSize(width, height, false);
    this.active.camera.aspect = width / Math.max(1, height);
    this.active.camera.updateProjectionMatrix();
  }

  render(frame: Omit<AudioFrame3D, "cameraAuto">) {
    if (this.userCam) this.controls?.update();
    this.active.update({ ...frame, cameraAuto: !this.userCam });
    this.renderer.render(this.active.scene, this.active.camera);
  }

  dispose() {
    this.renderer.domElement.removeEventListener("dblclick", this.onDblClick);
    this.controls?.dispose();
    this.active.dispose();
    this.renderer.dispose();
  }
}
