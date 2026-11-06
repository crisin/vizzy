// MorphScene — N variants of the same picture, laid out on a 2D control
// surface that the music moves a cursor across.
//
// The point, and the difference from every "play a generated clip" approach:
// the variants are never played in sequence. They are *coordinates*. The
// horizontal axis is timbre (spectral centroid — how bright the sound is),
// the vertical axis is energy, and whatever the music is doing right now
// picks a point between four of them. Bass-heavy and dull lands in one
// corner, loud and bright in another, and the picture is the blend. Nothing
// here loops, because there is no sequence to loop.
//
// Bake the variants in ComfyUI with the *same seed* and a varying
// prompt/IP-Adapter weight, so they share composition and differ in mood —
// that shared structure is what makes blending them read as one picture
// changing rather than two pictures on top of each other.
//
// Frames live in a single `sampler2DArray`: GLSL ES has no dynamic indexing
// of sampler uniforms, so an array texture is the only way to let the shader
// choose which four of N frames to read per frame.

import * as THREE from "three";
import { params } from "./params";

// mirrors the Scene3D contract in scenes3d.ts (not exported there)
interface AudioFrameLike {
  disp: Float32Array;
  wave: Float32Array;
  rms: number;
  beat: number;
  dt: number;
  t: number;
  cameraAuto: boolean;
}

const BG = 0x07070c;
const FOV = 45;
/** Frames are resized to this at most — the array texture is w*h*4*N bytes. */
const MAX_SIDE = 1280;

export type MorphAsset = {
  name: string;
  frames: ArrayBuffer[];
  frameType: string;
};

/**
 * Maps a signal onto 0..1 without knowing its range in advance: the floor
 * drops instantly and creeps back up, the ceiling does the mirror image. So
 * the window brackets whatever the track is doing and slowly tightens around
 * it — quiet music gets the full surface, not a cursor stuck in one corner.
 */
class AutoRange {
  private lo: number;
  private hi: number;

  constructor(lo = 0, hi = 1) {
    this.lo = lo;
    this.hi = hi;
  }

  norm(v: number, dt: number): number {
    const fast = Math.min(1, dt * 6);
    const slow = Math.min(1, dt * 0.1);
    this.lo += (v - this.lo) * (v < this.lo ? fast : slow);
    this.hi += (v - this.hi) * (v > this.hi ? fast : slow);
    const span = Math.max(1e-3, this.hi - this.lo);
    return Math.min(1, Math.max(0, (v - this.lo) / span));
  }
}

/** Grid that holds `n` frames: as square as it gets, filled row-major. */
export function gridFor(n: number): { cols: number; rows: number } {
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  const rows = Math.max(1, Math.ceil(n / cols));
  return { cols, rows };
}

/** Preview for the library cards: the first frame, scaled down. */
export function morphThumb(bitmap: ImageBitmap, side = 160): string {
  const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.72);
}

export class MorphScene {
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  cameraTarget = new THREE.Vector3(0, 0, 0);

  private mesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;
  private geometry: THREE.PlaneGeometry;
  private frames: THREE.DataArrayTexture;
  private count = 1;
  private imageAspect = 16 / 9;
  private viewAspect = 16 / 9;
  private dist = 3;
  private log: (msg: string) => void;
  private loadGeneration = 0;
  private disposed = false;

  private energy = new AutoRange(0, 0.3);
  private timbre = new AutoRange(0.2, 0.5);
  /** smoothed cursor on the control surface, both axes 0..1 */
  private cx = 0.5;
  private cy = 0.5;
  private beatPush = 0;
  private driftPhase = 0;

  constructor(aspect: number, log: (msg: string) => void = console.log) {
    this.log = log;
    this.viewAspect = aspect;
    this.camera = new THREE.PerspectiveCamera(FOV, aspect, 0.05, 50);
    this.scene.background = new THREE.Color(BG);

    const ph = placeholderFrames();
    this.frames = ph.texture;
    this.count = ph.count;
    this.imageAspect = ph.aspect;

    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        uFrames: { value: this.frames },
        uLayers: { value: new THREE.Vector4(0, 0, 0, 0) },
        uWeights: { value: new THREE.Vector4(1, 0, 0, 0) },
        uMode: { value: 0 },
        uSharp: { value: 2 },
        uGrain: { value: 90 },
        uTime: { value: 0 },
        uCover: { value: new THREE.Vector2(1, 1) },
        uPan: { value: new THREE.Vector2(0, 0) },
        uZoom: { value: 1 },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
    });

    this.geometry = new THREE.PlaneGeometry(2, 2);
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    // Child of the camera: the quad is meant to fill the frame, and grabbing
    // the mouse camera must not slide the picture off screen. Orbiting in
    // this scene simply does nothing, which is the honest behaviour.
    this.camera.add(this.mesh);
    this.scene.add(this.camera);
    this.fit();
  }

  /** Quad sits at the distance where a 2-unit plane exactly fills the view. */
  private fit() {
    const tan = Math.tan((FOV * Math.PI) / 360);
    this.dist = 1 / tan;
    this.mesh.position.set(0, 0, -this.dist);
    this.mesh.scale.set(this.viewAspect, 1, 1);
    this.camera.position.set(0, 0, 0);

    // "cover": crop the long side of the picture rather than letterbox it
    const cover = this.material.uniforms.uCover.value as THREE.Vector2;
    if (this.imageAspect > this.viewAspect) {
      cover.set(this.viewAspect / this.imageAspect, 1);
    } else {
      cover.set(1, this.imageAspect / this.viewAspect);
    }
  }

  /**
   * Decode every frame into one array texture. They are forced to a common
   * size (the first frame's, capped) because an array texture has exactly one
   * — variants out of one workflow already agree, so this only catches
   * mismatched hand-picked files.
   */
  async loadAsset(asset: MorphAsset) {
    const generation = ++this.loadGeneration;
    if (asset.frames.length === 0) return;
    try {
      const type = asset.frameType || "image/png";
      const bitmaps: ImageBitmap[] = [];
      for (const buf of asset.frames) {
        bitmaps.push(await createImageBitmap(new Blob([buf], { type })));
        if (this.disposed || generation !== this.loadGeneration) {
          for (const b of bitmaps) b.close();
          return;
        }
      }

      const scale = Math.min(
        1,
        MAX_SIDE / Math.max(bitmaps[0].width, bitmaps[0].height),
      );
      const w = Math.max(2, Math.round(bitmaps[0].width * scale));
      const h = Math.max(2, Math.round(bitmaps[0].height * scale));
      const n = bitmaps.length;

      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      const data = new Uint8Array(w * h * 4 * n);
      for (let i = 0; i < n; i++) {
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(bitmaps[i], 0, 0, w, h);
        const px = ctx.getImageData(0, 0, w, h).data;
        data.set(px, i * w * h * 4);
        bitmaps[i].close();
      }

      const texture = new THREE.DataArrayTexture(data, w, h, n);
      texture.format = THREE.RGBAFormat;
      texture.type = THREE.UnsignedByteType;
      // raw passthrough, same as the parallax scene — no colour conversion
      texture.colorSpace = THREE.NoColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.needsUpdate = true;

      this.frames.dispose();
      this.frames = texture;
      this.material.uniforms.uFrames.value = texture;
      this.count = n;
      this.imageAspect = w / h;
      this.fit();

      const { cols, rows } = gridFor(n);
      const mb = (data.byteLength / (1024 * 1024)).toFixed(1);
      this.log(
        `[morph] ${asset.name}: ${n} frames ${w}x${h} → ${cols}x${rows} grid, ${mb} MB`,
      );
    } catch (err) {
      this.log(`[morph] load FAILED: ${err}`);
    }
  }

  update(frame: AudioFrameLike) {
    const u = this.material.uniforms;
    const dt = Math.min(0.1, frame.dt);

    // --- where the music is, on the surface ---
    const centroid = spectralCentroid(frame.disp);
    const tx = this.timbre.norm(centroid, dt);
    const ty = this.energy.norm(frame.rms, dt);

    const gainX = params.get("morph", "achseX");
    const gainY = params.get("morph", "achseY");
    const jump = params.get("morph", "sprung");

    // a beat shoves the cursor up the energy axis and then lets go
    this.beatPush = Math.max(this.beatPush - dt * 2.5, frame.beat * jump);
    const targetX = clamp01(0.5 + (tx - 0.5) * gainX);
    const targetY = clamp01(0.5 + (ty - 0.5) * gainY + this.beatPush * 0.4);

    const follow = Math.min(1, dt * params.get("morph", "tempo"));
    this.cx += (targetX - this.cx) * follow;
    this.cy += (targetY - this.cy) * follow;

    // --- which four frames, and how much of each ---
    const { cols, rows } = gridFor(this.count);
    const gx = this.cx * (cols - 1);
    const gy = this.cy * (rows - 1);
    const col = Math.floor(gx);
    const row = Math.floor(gy);
    const fx = gx - col;
    const fy = gy - row;
    const at = (c: number, r: number) =>
      Math.min(
        this.count - 1,
        Math.min(rows - 1, Math.max(0, r)) * cols +
          Math.min(cols - 1, Math.max(0, c)),
      );
    (u.uLayers.value as THREE.Vector4).set(
      at(col, row),
      at(col + 1, row),
      at(col, row + 1),
      at(col + 1, row + 1),
    );
    (u.uWeights.value as THREE.Vector4).set(
      (1 - fx) * (1 - fy),
      fx * (1 - fy),
      (1 - fx) * fy,
      fx * fy,
    );

    // --- framing: slow drift so a still set still breathes, beat zoom ---
    const drift = params.get("morph", "drift");
    const pulse = params.get("morph", "puls");
    this.driftPhase += dt * (0.05 + frame.rms * 0.18);
    const p = this.driftPhase;
    (u.uPan.value as THREE.Vector2).set(
      Math.sin(p * 1.3) * 0.04 * drift,
      Math.sin(p * 0.9 + 1.1) * 0.04 * drift,
    );
    u.uZoom.value = 1 + drift * 0.06 + frame.beat * pulse * 0.07;

    u.uMode.value = Math.round(params.get("morph", "modus"));
    u.uSharp.value = params.get("morph", "schaerfe");
    u.uGrain.value = params.get("morph", "streuung");
    u.uTime.value = frame.t;
  }

  resize(aspect: number) {
    this.viewAspect = aspect;
    this.fit();
  }

  dispose() {
    this.disposed = true;
    this.camera.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
    this.frames.dispose();
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Centre of mass of the spectrum, in band-index space. The bands are already
 * log-spaced, so this tracks perceived brightness rather than raw Hz — and it
 * is the one cheap feature that separates "dull" from "bright" regardless of
 * how loud the track is.
 */
function spectralCentroid(bands: Float32Array): number {
  let num = 0;
  let den = 0;
  for (let i = 0; i < bands.length; i++) {
    num += i * bands[i];
    den += bands[i];
  }
  if (den < 1e-5) return 0.5;
  return num / den / Math.max(1, bands.length - 1);
}

/** Four tinted gradients, so the empty scene already shows what it does. */
function placeholderFrames(): {
  texture: THREE.DataArrayTexture;
  count: number;
  aspect: number;
} {
  const w = 256;
  const h = 144;
  const n = 4;
  const tints: [number, number, number][] = [
    [26, 34, 64],
    [96, 48, 92],
    [196, 120, 70],
    [240, 226, 190],
  ];
  const data = new Uint8Array(w * h * 4 * n);
  for (let i = 0; i < n; i++) {
    const [r, g, b] = tints[i];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const fall = 1 - (y / h) * 0.55;
        const ring =
          0.5 +
          0.5 *
            Math.sin(
              Math.hypot(x - w / 2, (y - h / 2) * 1.6) * 0.18 - i * 1.2,
            );
        const k = fall * (0.65 + ring * 0.35);
        const o = (i * w * h + y * w + x) * 4;
        data[o] = Math.min(255, r * k);
        data[o + 1] = Math.min(255, g * k);
        data[o + 2] = Math.min(255, b * k);
        data[o + 3] = 255;
      }
    }
  }
  const texture = new THREE.DataArrayTexture(data, w, h, n);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return { texture, count: n, aspect: w / h };
}

/* ----------------------------------------------------------------- shaders */

const VERTEX = /* glsl */ `
  out vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  precision highp float;
  precision highp sampler2DArray;

  uniform sampler2DArray uFrames;
  uniform vec4 uLayers;
  uniform vec4 uWeights;
  uniform float uMode;
  uniform float uSharp;
  uniform float uGrain;
  uniform float uTime;
  uniform vec2 uCover;
  uniform vec2 uPan;
  uniform float uZoom;

  in vec2 vUv;
  out vec4 fragColor;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  void main() {
    // cover-fit, Ken Burns drift, beat zoom — and flip V, because an array
    // texture is uploaded as raw rows with no flipY to lean on
    vec2 uv = (vUv - 0.5) / uZoom + 0.5 + uPan;
    uv = (uv - 0.5) * uCover + 0.5;
    uv.y = 1.0 - uv.y;
    uv = clamp(uv, 0.0, 1.0);

    // Sharpening the weights pulls the blend toward the dominant variant.
    // Linear bilinear weights spend most of their time near equal, which is
    // exactly where four pictures average into mush.
    vec4 w = pow(max(uWeights, 0.0), vec4(uSharp));
    float sum = w.x + w.y + w.z + w.w;
    w = sum > 1e-6 ? w / sum : vec4(1.0, 0.0, 0.0, 0.0);

    vec3 c0 = texture(uFrames, vec3(uv, uLayers.x)).rgb;
    vec3 c1 = texture(uFrames, vec3(uv, uLayers.y)).rgb;
    vec3 c2 = texture(uFrames, vec3(uv, uLayers.z)).rgb;
    vec3 c3 = texture(uFrames, vec3(uv, uLayers.w)).rgb;

    vec3 col;
    int mode = int(uMode + 0.5);
    if (mode == 1) {
      // dissolve: every pixel picks one whole variant, so nothing is ever
      // averaged and the transition reads as grain rather than as fog
      float r = hash(floor(vUv * uGrain) + floor(uTime * 12.0) * 0.137);
      float a = w.x;
      float b = a + w.y;
      float c = b + w.z;
      col = r < a ? c0 : r < b ? c1 : r < c ? c2 : c3;
    } else if (mode == 2) {
      // brightest wins per channel: highlights from the louder variants cut
      // through instead of being averaged away
      vec3 m = max(max(c0 * (0.35 + w.x), c1 * (0.35 + w.y)),
                   max(c2 * (0.35 + w.z), c3 * (0.35 + w.w)));
      col = m;
    } else {
      col = c0 * w.x + c1 * w.y + c2 * w.z + c3 * w.w;
    }

    fragColor = vec4(col, 1.0);
  }
`;
