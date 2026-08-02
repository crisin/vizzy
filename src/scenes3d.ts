import * as THREE from "three";
import { params } from "./params";

export interface AudioFrame3D {
  disp: Float32Array; // smoothed bands 0..1
  wave: Float32Array;
  rms: number;
  beat: number; // beat envelope 0..1
  dt: number;
  t: number;
}

export type SceneName = "orb" | "terrain" | "tunnel";
export const SCENE_NAMES: SceneName[] = ["orb", "terrain", "tunnel"];

const BG = 0x07070c;
const NUM_BANDS = 64;

interface Scene3D {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
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

/** Scrolling spectrogram mountains: rows of band history flow toward the camera. */
class TerrainScene implements Scene3D {
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  private mesh: THREE.Mesh;
  private geometry: THREE.PlaneGeometry;
  private material: THREE.MeshBasicMaterial;
  private heights: Float32Array;
  private rowAcc = 0;
  private readonly cols = NUM_BANDS;
  private readonly rows = 96;
  private color = new THREE.Color();

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(70, aspect, 0.1, 200);
    this.camera.position.set(0, 15, 52);
    this.camera.lookAt(0, 2, -20);
    this.scene.fog = new THREE.Fog(BG, 35, 95);

    this.heights = new Float32Array(this.rows * this.cols);
    this.geometry = new THREE.PlaneGeometry(
      64,
      100,
      this.cols - 1,
      this.rows - 1,
    );
    this.geometry.rotateX(-Math.PI / 2);
    const vertCount = this.cols * this.rows;
    this.geometry.setAttribute(
      "color",
      new THREE.BufferAttribute(new Float32Array(vertCount * 3), 3),
    );

    this.material = new THREE.MeshBasicMaterial({
      wireframe: true,
      vertexColors: true,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.scene.add(this.mesh);
  }

  update(frame: AudioFrame3D) {
    const { cols, rows, heights } = this;

    // time-based flow: shift N rows toward the camera this frame
    this.rowAcc += frame.dt * params.get("terrain", "speed");
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
    const hScale = params.get("terrain", "height") * (1 + frame.beat * 0.2);
    for (let i = 0; i < heights.length; i++) {
      const h = heights[i];
      pos.setY(i, h * hScale);
      this.color.setHSL(0.72 - h * 0.45, 0.85, 0.22 + h * 0.5);
      col.setXYZ(i, this.color.r, this.color.g, this.color.b);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;

    const sway = params.get("terrain", "sway");
    this.camera.position.x = Math.sin(frame.t * 0.1) * sway;
    this.camera.lookAt(0, 2, -20);
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/** Fly through rings whose shape is a spectrum snapshot from when they spawned. */
class TunnelScene implements Scene3D {
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
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
    this.camera.position.x = Math.sin(frame.t * 0.6) * 0.6;
    this.camera.position.y = Math.cos(frame.t * 0.45) * 0.5;
    this.camera.lookAt(0, 0, this.camera.position.z - 30);
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

/** Owns the WebGL renderer on its canvas and the active 3D scene. */
export class Viz3D {
  private renderer: THREE.WebGLRenderer;
  private active: Scene3D;
  private name: SceneName;
  private dpr: number;

  constructor(canvas: HTMLCanvasElement, initial: SceneName = "orb") {
    this.dpr = window.devicePixelRatio || 1;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setClearColor(BG, 1);
    this.name = initial;
    this.active = this.create(initial);
    this.resize(canvas.width, canvas.height);
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
    }
  }

  setScene(name: SceneName) {
    if (name === this.name) return;
    this.active.dispose();
    this.name = name;
    this.active = this.create(name);
  }

  resize(width: number, height: number) {
    this.renderer.setSize(width, height, false);
    this.active.camera.aspect = width / Math.max(1, height);
    this.active.camera.updateProjectionMatrix();
  }

  render(frame: AudioFrame3D) {
    this.active.update(frame);
    this.renderer.render(this.active.scene, this.active.camera);
  }

  dispose() {
    this.active.dispose();
    this.renderer.dispose();
  }
}
