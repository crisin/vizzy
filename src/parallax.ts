// ParallaxScene — a still image turned into a 2.5D relief by a depth map.
//
// The depth map comes from a ComfyUI bake (Depth Anything V2 or similar) and
// is only ever generated once per picture; everything that *moves* happens
// here, per frame, driven by the audio. That split is the whole point: an
// offline model buys quality, the realtime side buys life. A generated video
// clip would have neither — it plays the same five seconds whatever the music
// does.
//
// Without a baked depth map the scene falls back to a pseudo depth derived
// from the image itself (vertical gradient + blurred luminance), so a picture
// is usable the moment it is dropped in. It is visibly cruder — real depth is
// the upgrade path, not an optional extra.

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

const NUM_BANDS = 64;
const BG = 0x07070c;
const FOV = 45;
/** Half-height of the plane. Everything beyond the viewport is headroom for
 *  the camera swing — without it, swinging pulls the plane's own edge into
 *  frame. The price is crop: parallax means showing less than the full
 *  picture, and the more the camera moves the more it costs. */
const OVERSCAN = 1.6;
/** Peak excursion of the swing per unit of the `schwenk` parameter. Must match
 *  the Lissajous figure in `update()`. */
const SWING_X = 0.88;
const SWING_Y = 0.34;

export type ParallaxAsset = {
  name: string;
  image: ArrayBuffer;
  imageType: string;
  depth?: ArrayBuffer;
  depthType?: string;
};

/* ------------------------------------------------------------------ depth */

/**
 * Stand-in depth map derived from the picture alone. Two weak cues, mixed:
 * lower in the frame is usually nearer, and brighter is *often* nearer within
 * a subject. Blurred hard, because a noisy depth map facets the mesh.
 * Convention of the output: white = near, black = far.
 *
 * Expects a bottom-up bitmap (decoded with `imageOrientation: "flipY"`) and
 * returns a bottom-up canvas, so row 0 is the bottom of the picture.
 */
export function pseudoDepth(bitmap: ImageBitmap, maxSide = 320): HTMLCanvasElement {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(8, Math.round(bitmap.width * scale));
  const h = Math.max(8, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0, w, h);

  const px = ctx.getImageData(0, 0, w, h);
  let field = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    // bottom of the frame reads as near — and row 0 *is* the bottom here
    const vertical = h > 1 ? 1 - y / (h - 1) : 0.5;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const lum =
        (px.data[i] * 0.299 + px.data[i + 1] * 0.587 + px.data[i + 2] * 0.114) /
        255;
      field[y * w + x] = vertical * 0.65 + lum * 0.35;
    }
  }

  field = boxBlur(field, w, h, 4, 3);

  for (let i = 0; i < field.length; i++) {
    const v = Math.max(0, Math.min(1, field[i])) * 255;
    px.data[i * 4] = v;
    px.data[i * 4 + 1] = v;
    px.data[i * 4 + 2] = v;
    px.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(px, 0, 0);
  return canvas;
}

/** Separable box blur, `passes` iterations — cheap approximation of a gaussian. */
function boxBlur(
  src: Float32Array,
  w: number,
  h: number,
  radius: number,
  passes: number,
): Float32Array {
  let a = src;
  let b = new Float32Array(src.length);
  for (let p = 0; p < passes; p++) {
    // horizontal
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        let n = 0;
        for (let k = -radius; k <= radius; k++) {
          const xx = x + k;
          if (xx < 0 || xx >= w) continue;
          sum += a[y * w + xx];
          n++;
        }
        b[y * w + x] = sum / n;
      }
    }
    // vertical
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        let n = 0;
        for (let k = -radius; k <= radius; k++) {
          const yy = y + k;
          if (yy < 0 || yy >= h) continue;
          sum += b[yy * w + x];
          n++;
        }
        a[y * w + x] = sum / n;
      }
    }
  }
  return a;
}

/** Placeholder picture + matching depth, so the empty scene still reads as 3D. */
function placeholder(): { color: HTMLCanvasElement; depth: HTMLCanvasElement } {
  const w = 512;
  const h = 288;
  const color = document.createElement("canvas");
  color.width = w;
  color.height = h;
  const cc = color.getContext("2d")!;
  const grad = cc.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, "#0b1220");
  grad.addColorStop(0.5, "#1e293b");
  grad.addColorStop(1, "#312e5e");
  cc.fillStyle = grad;
  cc.fillRect(0, 0, w, h);

  const depth = document.createElement("canvas");
  depth.width = w;
  depth.height = h;
  const dc = depth.getContext("2d")!;
  const dg = dc.createLinearGradient(0, 0, 0, h);
  dg.addColorStop(0, "#000");
  dg.addColorStop(1, "#fff");
  dc.fillStyle = dg;
  dc.fillRect(0, 0, w, h);

  // concentric ridges in both maps — gives the placeholder visible relief
  for (let i = 0; i < 14; i++) {
    const r = 18 + i * 16;
    const v = Math.round(255 * (1 - i / 14));
    dc.strokeStyle = `rgba(${v},${v},${v},0.5)`;
    dc.lineWidth = 7;
    dc.beginPath();
    dc.arc(w / 2, h / 2, r, 0, Math.PI * 2);
    dc.stroke();

    cc.strokeStyle = `rgba(56,189,248,${0.08 + (1 - i / 14) * 0.2})`;
    cc.lineWidth = 3;
    cc.beginPath();
    cc.arc(w / 2, h / 2, r, 0, Math.PI * 2);
    cc.stroke();
  }

  cc.fillStyle = "rgba(226,232,240,0.75)";
  cc.font = "600 20px system-ui, sans-serif";
  cc.textAlign = "center";
  cc.fillText("Bild laden →", w / 2, h - 28);
  return { color, depth };
}

/** Small data-URL preview for the library cards, from a bottom-up bitmap. */
export function imageThumb(bitmap: ImageBitmap, side = 160): string {
  const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d")!;
  // the bitmap is flipped for the GPU; flip it back for human eyes
  ctx.translate(0, canvas.height);
  ctx.scale(1, -1);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.72);
}

/* ------------------------------------------------------------------ scene */

export class ParallaxScene {
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  cameraTarget = new THREE.Vector3(0, 0, 0);

  private mesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;
  private mdTex: THREE.Texture | null = null;
  private geometry: THREE.PlaneGeometry;
  private colorTex: THREE.Texture;
  private depthTex: THREE.Texture;
  private imageAspect = 16 / 9;
  private viewAspect = 16 / 9;
  private segments = 0;
  private homeDist = 3;
  private log: (msg: string) => void;
  private loadGeneration = 0;
  private disposed = false;
  /** slow envelope on the bass, so the breathing does not stutter */
  private bassEnv = 0;
  private swingPhase = 0;

  constructor(aspect: number, log: (msg: string) => void = console.log) {
    this.log = log;
    this.viewAspect = aspect;
    this.camera = new THREE.PerspectiveCamera(FOV, aspect, 0.05, 120);
    this.scene.background = new THREE.Color(BG);

    const ph = placeholder();
    this.colorTex = this.makeTexture(ph.color, true);
    this.depthTex = this.makeTexture(ph.depth, true);
    this.imageAspect = ph.color.width / ph.color.height;

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      uniforms: {
        uMap: { value: this.colorTex },
        uDepth: { value: this.depthTex },
        uDepthScale: { value: 0.55 },
        uInvert: { value: 0 },
        uBands: { value: new Float32Array(NUM_BANDS) },
        uSpectrum: { value: 0.35 },
        uBeat: { value: 0 },
        uGlitch: { value: 0 },
        uEdge: { value: 0.5 },
        uHaze: { value: 0.3 },
        uTime: { value: 0 },
        uTexel: { value: new THREE.Vector2(1 / 512, 1 / 512) },
        uFog: { value: new THREE.Color(BG) },
        uMd: { value: BLACK },
        uMdMode: { value: 0 },
        uMdNear: { value: 0.8 },
        uMdFar: { value: 0.25 },
        uMdAmount: { value: 1 },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
    });

    this.geometry = new THREE.PlaneGeometry(1, 1, 1, 1); // replaced by rebuild()
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.scene.add(this.mesh);
    this.rebuild(Math.round(params.get("parallax", "detail")));
    this.home();
  }

  /** Mesh density is a parameter: the relief is pure vertex displacement, so
   *  detail costs triangles and nothing else. */
  private rebuild(segments: number) {
    if (segments === this.segments) return;
    this.segments = segments;
    this.geometry?.dispose();
    const h = 2 * OVERSCAN;
    const w = h * this.imageAspect;
    // keep triangles roughly square across non-square images
    const segX = Math.max(8, Math.round(segments * Math.min(2, this.imageAspect)));
    this.geometry = new THREE.PlaneGeometry(w, h, segX, segments);
    this.mesh.geometry = this.geometry;
  }

  /**
   * Distance at which the plane still covers the viewport at the far end of
   * the swing. Cheap enough to redo every frame, which is what lets the
   * swing slider stay honest instead of tearing the edge open.
   */
  private fit(swing: number) {
    const tan = Math.tan((FOV * Math.PI) / 360);
    const halfH = Math.max(0.2, OVERSCAN - SWING_Y * swing);
    const halfW = Math.max(0.2, OVERSCAN * this.imageAspect - SWING_X * swing);
    this.homeDist = Math.max(
      0.3,
      Math.min(halfH / tan, halfW / (tan * this.viewAspect)),
    );
  }

  /** Park the camera at its home position (scene creation, resize, reload). */
  private home() {
    this.fit(params.get("parallax", "schwenk"));
    this.camera.position.set(0, 0, this.homeDist);
    this.camera.lookAt(0, 0, 0);
  }

  /**
   * `flipY` is explicit because three ignores `Texture.flipY` for ImageBitmap
   * sources — those are decoded bottom-up via `imageOrientation: "flipY"`
   * instead, and anything derived from them is bottom-up too. Colour and depth
   * map must agree, or the relief ends up mirrored against the picture.
   */
  private makeTexture(source: TexImageSource, flipY: boolean): THREE.Texture {
    const tex = new THREE.Texture(source);
    tex.flipY = flipY;
    // Raw passthrough: the shader writes the sampled bytes straight out, so no
    // colour-space conversion happens on either end and what we show matches
    // the source file exactly.
    tex.colorSpace = THREE.NoColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return tex;
  }

  /**
   * Swap in an image and its depth map. Both arrive as raw bytes so nothing
   * has to juggle object-URL lifetimes; decoding happens off the main thread
   * in `createImageBitmap`.
   */
  async loadAsset(asset: ParallaxAsset) {
    const generation = ++this.loadGeneration;
    try {
      const colorBitmap = await createImageBitmap(
        new Blob([asset.image], { type: asset.imageType || "image/png" }),
        { imageOrientation: "flipY" },
      );
      if (this.disposed || generation !== this.loadGeneration) return;

      let depthSource: TexImageSource;
      let depthW: number;
      let depthH: number;
      if (asset.depth) {
        const depthBitmap = await createImageBitmap(
          new Blob([asset.depth], { type: asset.depthType || "image/png" }),
          { imageOrientation: "flipY" },
        );
        if (this.disposed || generation !== this.loadGeneration) return;
        depthSource = depthBitmap;
        depthW = depthBitmap.width;
        depthH = depthBitmap.height;
        this.log(`[parallax] depth map ${depthW}x${depthH} (baked)`);
      } else {
        // derived from the already-flipped bitmap, so it is bottom-up as well
        const canvas = pseudoDepth(colorBitmap);
        depthSource = canvas;
        depthW = canvas.width;
        depthH = canvas.height;
        this.log(`[parallax] depth map ${depthW}x${depthH} (pseudo, no bake)`);
      }

      this.colorTex.dispose();
      this.depthTex.dispose();
      this.colorTex = this.makeTexture(colorBitmap, false);
      this.depthTex = this.makeTexture(depthSource, false);
      this.material.uniforms.uMap.value = this.colorTex;
      this.material.uniforms.uDepth.value = this.depthTex;
      // blur/gradient taps scale with the depth map, not the colour map
      (this.material.uniforms.uTexel.value as THREE.Vector2).set(
        1.5 / depthW,
        1.5 / depthH,
      );

      this.imageAspect = colorBitmap.width / Math.max(1, colorBitmap.height);
      const segments = this.segments;
      this.segments = 0; // force the aspect change through
      this.rebuild(segments);
      this.home();
      this.log(
        `[parallax] loaded ${asset.name} (${colorBitmap.width}x${colorBitmap.height})`,
      );
    } catch (err) {
      this.log(`[parallax] load FAILED: ${err}`);
    }
  }

  update(frame: AudioFrameLike) {
    const u = this.material.uniforms;

    const bass = mean(frame.disp, 0, 8);
    // asymmetric envelope: snap up on a hit, sag back slowly
    const target = bass;
    const k = target > this.bassEnv ? 12 : 2.5;
    this.bassEnv += (target - this.bassEnv) * Math.min(1, frame.dt * k);

    const depth = params.get("parallax", "tiefe");
    const breath = params.get("parallax", "atmung");
    const kick = params.get("parallax", "kick");
    const swing = params.get("parallax", "schwenk");

    u.uDepthScale.value = depth * (1 + this.bassEnv * breath * 0.8);
    u.uInvert.value = params.get("parallax", "invert");
    u.uSpectrum.value = params.get("parallax", "spektrum");
    u.uEdge.value = params.get("parallax", "kanten");
    u.uHaze.value = params.get("parallax", "dunst");
    u.uGlitch.value = params.get("parallax", "glitch");
    u.uBeat.value = frame.beat;
    u.uTime.value = frame.t;
    (u.uBands.value as Float32Array).set(frame.disp);
    const md = this.mdTex ? params.get("parallax", "md") | 0 : 0;
    u.uMdMode.value = md;
    if (md) {
      u.uMd.value = this.mdTex;
      u.uMdNear.value = params.get("parallax", "mdNah");
      u.uMdFar.value = params.get("parallax", "mdFern");
      u.uMdAmount.value = 1 + frame.beat * params.get("parallax", "mdKick");
    }

    this.rebuild(Math.round(params.get("parallax", "detail")));
    this.fit(swing);

    if (frame.cameraAuto) {
      // drift speed rides on the loudness, so quiet passages settle down
      this.swingPhase += frame.dt * (0.08 + frame.rms * 0.5);
      const p = this.swingPhase;
      const x = Math.sin(p * 1.7) * 0.6 + Math.sin(p * 0.73 + 1.3) * 0.28;
      const y = Math.sin(p * 1.3 + 0.7) * 0.34;
      this.camera.position.set(
        x * swing,
        y * swing,
        this.homeDist - frame.beat * kick * 0.22 - this.bassEnv * 0.12,
      );
      this.camera.lookAt(0, 0, 0);
    }
  }

  /** The live Milkdrop picture, or null while it is not rendered. */
  setMilkdrop(tex: THREE.Texture | null) {
    this.mdTex = tex;
  }

  /** Whether the scene currently wants the Milkdrop picture. */
  wantsMilkdrop(): boolean {
    return (params.get("parallax", "md") | 0) > 0;
  }

  resize(aspect: number) {
    this.viewAspect = aspect;
    this.home();
  }

  dispose() {
    this.disposed = true;
    this.geometry.dispose();
    this.material.dispose();
    this.colorTex.dispose();
    this.depthTex.dispose();
  }
}

function mean(arr: Float32Array, from: number, to: number): number {
  let sum = 0;
  const end = Math.min(to, arr.length);
  for (let i = from; i < end; i++) sum += arr[i];
  return end > from ? sum / (end - from) : 0;
}

/** Stand-in for the Milkdrop texture while there is none. */
const BLACK = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
BLACK.needsUpdate = true;

/* ----------------------------------------------------------------- shaders */

const VERTEX = /* glsl */ `
  uniform sampler2D uDepth;
  uniform float uDepthScale;
  uniform float uInvert;
  uniform float uBands[${NUM_BANDS}];
  uniform float uSpectrum;
  uniform vec2 uTexel;
  varying vec2 vUv;
  varying float vNear;

  // 1 = near, 0 = far. Depth Anything and friends output inverse depth
  // (bright = near), which is this convention already; uInvert flips the
  // classic "white is far" maps.
  float depthAt(vec2 uv) {
    float d = texture2D(uDepth, uv).r * 2.0;
    d += texture2D(uDepth, uv + vec2(uTexel.x, 0.0)).r;
    d += texture2D(uDepth, uv - vec2(uTexel.x, 0.0)).r;
    d += texture2D(uDepth, uv + vec2(0.0, uTexel.y)).r;
    d += texture2D(uDepth, uv - vec2(0.0, uTexel.y)).r;
    d /= 6.0;
    return mix(d, 1.0 - d, uInvert);
  }

  void main() {
    vUv = uv;
    float d = depthAt(uv);
    vNear = d;

    // the spectrum runs bottom (bass) to top (treble) up the picture and
    // ripples the surface on top of its own relief
    float f = clamp(uv.y, 0.0, 0.999) * ${NUM_BANDS - 1}.0;
    int i = int(f);
    int j = i + 1;
    if (j > ${NUM_BANDS - 1}) j = ${NUM_BANDS - 1};
    float band = mix(uBands[i], uBands[j], fract(f));

    vec3 p = position;
    p.z += (d - 0.5) * uDepthScale + band * uSpectrum * 0.3;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

// No explicit `precision` line: three prepends the same one to both stages,
// and uTexel is shared — declaring mediump here only in the fragment shader
// makes the program fail to link.
const FRAGMENT = /* glsl */ `
  uniform sampler2D uMap;
  uniform sampler2D uDepth;
  uniform float uEdge;
  uniform float uHaze;
  uniform float uGlitch;
  uniform float uBeat;
  uniform float uTime;
  uniform vec2 uTexel;
  uniform vec3 uFog;
  uniform sampler2D uMd;
  uniform float uMdMode;
  uniform float uMdNear;
  uniform float uMdFar;
  uniform float uMdAmount;
  varying vec2 vUv;
  varying float vNear;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
  }

  void main() {
    vec2 uv = vUv;

    // beat-triggered horizontal slices — reads as the picture tearing on the hit
    if (uGlitch > 0.0 && uBeat > 0.01) {
      float row = floor(uv.y * 44.0);
      float h = hash(vec2(row, floor(uTime * 9.0)));
      uv.x += (h - 0.5) * uGlitch * uBeat * 0.07;
    }

    // Milkdrop on the picture, weighted by depth: near and far get their
    // own strength, so the foreground can dance while the distance stays put
    float mdW = mix(uMdFar, uMdNear, vNear) * uMdAmount;
    int mdMode = int(uMdMode + 0.5);
    vec3 md = mdMode > 0 ? texture2D(uMd, vUv).rgb : vec3(0.0);
    if (mdMode == 2) {
      // warp: the gradient of the Milkdrop picture pushes the image around
      vec3 mx = texture2D(uMd, vUv + vec2(0.006, 0.0)).rgb;
      vec3 my = texture2D(uMd, vUv + vec2(0.0, 0.006)).rgb;
      vec2 g = vec2(dot(mx - md, vec3(0.333)), dot(my - md, vec3(0.333)));
      uv += g * mdW * 0.6;
    }

    vec4 c = texture2D(uMap, clamp(uv, 0.0, 1.0));

    // A displaced grid stretches like rubber across depth cliffs. Fading the
    // steep fragments out hides the smear and reads as real occlusion.
    float dl = texture2D(uDepth, vUv - vec2(uTexel.x, 0.0)).r;
    float dr = texture2D(uDepth, vUv + vec2(uTexel.x, 0.0)).r;
    float dd = texture2D(uDepth, vUv - vec2(0.0, uTexel.y)).r;
    float du = texture2D(uDepth, vUv + vec2(0.0, uTexel.y)).r;
    float grad = length(vec2(dr - dl, du - dd));
    float alpha = 1.0 - uEdge * smoothstep(0.03, 0.17, grad);

    // far pixels sink toward the background — cheap aerial perspective
    vec3 rgb = mix(c.rgb, uFog, (1.0 - vNear) * uHaze);
    rgb *= 0.94 + uBeat * 0.22;

    if (mdMode == 1) {
      // light: Milkdrop colours the picture like a projector would, with a
      // threshold so dark Milkdrop areas don't grey the image out
      float lum = dot(md, vec3(0.299, 0.587, 0.114));
      vec3 lit = rgb * (0.35 + 1.6 * md) + md * 0.35 * smoothstep(0.15, 0.6, lum);
      rgb = mix(rgb, lit, clamp(mdW, 0.0, 1.5));
    } else if (mdMode == 3) {
      // reflection: only where the picture itself is bright
      float bright = smoothstep(0.5, 0.9, dot(c.rgb, vec3(0.333)));
      rgb += md * bright * mdW * 1.2;
    }

    gl_FragColor = vec4(rgb, c.a * alpha);
  }
`;
