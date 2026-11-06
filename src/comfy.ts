// Frontend side of the ComfyUI bake. The HTTP work happens in Rust
// (src-tauri/src/comfy.rs) because ComfyUI serves no CORS headers by
// default; this module only holds the settings, the workflow template and
// the invoke wrappers.

import { invoke } from "@tauri-apps/api/core";

export const IMAGE_TOKEN = "__VIZZY_INPUT_IMAGE__";

/**
 * Axis placeholders for a variant bake. One ComfyUI run per grid cell, with
 * these replaced by that cell's coordinates — which is the only way the morph
 * grid's axes come to mean anything. A single batched run shares its
 * conditioning across the batch, so every output differs only by noise: the
 * set is coherent but unordered, and an unordered set makes "right is
 * brighter" a lie.
 *
 * They substitute as bare numbers, so they work both inside a prompt string
 * (`"(golden hour:__VIZZY_X__)"`) and as a node input (`"denoise": __VIZZY_Y__`).
 */
export const X_TOKEN = "__VIZZY_X__";
export const Y_TOKEN = "__VIZZY_Y__";
export const INDEX_TOKEN = "__VIZZY_INDEX__";

export const DEFAULT_COMFY_URL = "http://127.0.0.1:8188";

/**
 * Depth bake in ComfyUI's API format (the "Export (API)" flavour, not the
 * editor's own save format).
 *
 * Needs the `comfyui_controlnet_aux` custom nodes for
 * `DepthAnythingV2Preprocessor` — that is the one assumption here that may
 * not hold on a given install, which is exactly why this is an editable
 * template and not hardcoded. Swap the middle node for whatever depth
 * estimator you have; only the `__VIZZY_INPUT_IMAGE__` placeholder and a
 * single image-saving node at the end are required.
 */
export const DEFAULT_DEPTH_WORKFLOW = JSON.stringify(
  {
    "1": {
      class_type: "LoadImage",
      inputs: { image: IMAGE_TOKEN, upload: "image" },
    },
    "2": {
      class_type: "DepthAnythingV2Preprocessor",
      inputs: {
        image: ["1", 0],
        ckpt_name: "depth_anything_v2_vitl.pth",
        resolution: 1024,
      },
    },
    "3": {
      class_type: "SaveImage",
      inputs: { images: ["2", 0], filename_prefix: "vizzy_depth" },
    },
  },
  null,
  2,
);

/**
 * Variant bake for the morph grid: one cell of the grid per run.
 *
 * Core nodes only, so it works on a bare ComfyUI. The two axes ride on prompt
 * weights, which is where a 0..1 number is idiomatic anyway — `__VIZZY_X__`
 * is brightness/warmth (the grid's timbre axis) and `__VIZZY_Y__` is
 * intensity (its energy axis).
 *
 * The seed is a literal, so every cell shares it: that shared structure is
 * what makes the blends read as one picture changing rather than as several
 * pictures stacked. `denoise` is the other half of that bargain — high enough
 * for the prompt to bite, low enough for the composition to survive.
 *
 * `ckpt_name` has to match a checkpoint you actually have.
 */
export const DEFAULT_VARIANT_WORKFLOW = JSON.stringify(
  {
    "1": {
      class_type: "LoadImage",
      inputs: { image: IMAGE_TOKEN, upload: "image" },
    },
    "2": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: "sd_xl_base_1.0.safetensors" },
    },
    "3": {
      class_type: "CLIPTextEncode",
      inputs: {
        clip: ["2", 1],
        text: `the same scene, (bright warm daylight:${X_TOKEN}), (dark intense storm:${Y_TOKEN})`,
      },
    },
    "4": {
      class_type: "CLIPTextEncode",
      inputs: { clip: ["2", 1], text: "text, watermark, blurry" },
    },
    "5": {
      class_type: "VAEEncode",
      inputs: { pixels: ["1", 0], vae: ["2", 2] },
    },
    "6": {
      class_type: "KSampler",
      inputs: {
        model: ["2", 0],
        positive: ["3", 0],
        negative: ["4", 0],
        latent_image: ["5", 0],
        // same seed in every cell — the variants must share structure
        seed: 1234,
        steps: 20,
        cfg: 6,
        sampler_name: "dpmpp_2m",
        scheduler: "karras",
        denoise: 0.45,
      },
    },
    "7": { class_type: "VAEDecode", inputs: { samples: ["6", 0], vae: ["2", 2] } },
    "8": {
      class_type: "SaveImage",
      inputs: { images: ["7", 0], filename_prefix: `vizzy_cell_${INDEX_TOKEN}` },
    },
  },
  null,
  2,
);

/** Grid sizes offered for a variant bake; each is `n × n` cells. */
export const GRID_SIZES = [2, 3, 4] as const;

export type AxisRanges = {
  side: number;
  xFrom: number;
  xTo: number;
  yFrom: number;
  yTo: number;
};

export const DEFAULT_AXES: AxisRanges = {
  side: 3,
  // prompt-weight range: 0 would delete the term, so start above it
  xFrom: 0.3,
  xTo: 1.4,
  yFrom: 0.3,
  yTo: 1.4,
};

/**
 * Cell coordinates in the order the morph grid reads them: row-major, row 0
 * the low end of the energy axis. Must stay in step with `gridFor` in
 * morph.ts, or the picture will not match the sound.
 */
export function gridCells(
  axes: AxisRanges,
): { index: number; x: number; y: number }[] {
  const n = Math.max(1, Math.round(axes.side));
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const cells = [];
  for (let i = 0; i < n * n; i++) {
    const col = i % n;
    const row = Math.floor(i / n);
    cells.push({
      index: i,
      x: lerp(axes.xFrom, axes.xTo, n === 1 ? 0.5 : col / (n - 1)),
      y: lerp(axes.yFrom, axes.yTo, n === 1 ? 0.5 : row / (n - 1)),
    });
  }
  return cells;
}

/**
 * Substitute one cell's coordinates into the template. Numbers are written
 * fixed-point: a bare `__VIZZY_X__` as a node input has to survive as JSON,
 * and exponent notation (`1e-7`) would not round-trip through every consumer.
 */
export function fillAxes(
  workflow: string,
  cell: { index: number; x: number; y: number },
): string {
  return workflow
    .split(X_TOKEN)
    .join(cell.x.toFixed(3))
    .split(Y_TOKEN)
    .join(cell.y.toFixed(3))
    .split(INDEX_TOKEN)
    .join(String(cell.index + 1));
}

export type BakeKind = "depth" | "variants";

const URL_KEY = "vizzy.comfy.url";
const WORKFLOW_KEY: Record<BakeKind, string> = {
  depth: "vizzy.comfy.workflow.depth",
  variants: "vizzy.comfy.workflow.variants",
};

export const DEFAULT_WORKFLOW: Record<BakeKind, string> = {
  depth: DEFAULT_DEPTH_WORKFLOW,
  variants: DEFAULT_VARIANT_WORKFLOW,
};

const AXES_KEY = "vizzy.comfy.axes";

export function loadAxes(): AxisRanges {
  try {
    const raw = localStorage.getItem(AXES_KEY);
    if (!raw) return DEFAULT_AXES;
    const parsed = JSON.parse(raw) as Partial<AxisRanges>;
    const num = (v: unknown, fallback: number) =>
      typeof v === "number" && Number.isFinite(v) ? v : fallback;
    return {
      side: GRID_SIZES.includes(parsed.side as (typeof GRID_SIZES)[number])
        ? (parsed.side as number)
        : DEFAULT_AXES.side,
      xFrom: num(parsed.xFrom, DEFAULT_AXES.xFrom),
      xTo: num(parsed.xTo, DEFAULT_AXES.xTo),
      yFrom: num(parsed.yFrom, DEFAULT_AXES.yFrom),
      yTo: num(parsed.yTo, DEFAULT_AXES.yTo),
    };
  } catch {
    return DEFAULT_AXES;
  }
}

export function saveAxes(axes: AxisRanges) {
  try {
    localStorage.setItem(AXES_KEY, JSON.stringify(axes));
  } catch {
    // storage unavailable — the values still apply for this session
  }
}

export function loadComfyUrl(): string {
  try {
    return localStorage.getItem(URL_KEY) || DEFAULT_COMFY_URL;
  } catch {
    return DEFAULT_COMFY_URL;
  }
}

export function saveComfyUrl(url: string) {
  try {
    localStorage.setItem(URL_KEY, url);
  } catch {
    // storage unavailable — the value still applies for this session
  }
}

export function loadWorkflow(kind: BakeKind): string {
  try {
    return localStorage.getItem(WORKFLOW_KEY[kind]) || DEFAULT_WORKFLOW[kind];
  } catch {
    return DEFAULT_WORKFLOW[kind];
  }
}

export function saveWorkflow(kind: BakeKind, json: string) {
  try {
    if (json.trim() === DEFAULT_WORKFLOW[kind].trim()) {
      localStorage.removeItem(WORKFLOW_KEY[kind]);
    } else {
      localStorage.setItem(WORKFLOW_KEY[kind], json);
    }
  } catch {
    // see above
  }
}

/** Reachability check — resolves with a short description of the install. */
export function comfyPing(url: string): Promise<string> {
  return invoke<string>("comfy_ping", { url });
}

/**
 * Run `workflow` over `image` and return every image it saved, in order.
 *
 * The input travels as base64 — Tauri's IPC payload is JSON, where a byte
 * array becomes a list of numbers, several times the size. The results come
 * back framed as `[u32 count][u32 len]*count[bytes]*count` (little-endian),
 * which keeps a nine-frame variant bake out of JSON entirely.
 */
export async function comfyBake(
  url: string,
  workflow: string,
  image: ArrayBuffer,
  filename: string,
): Promise<ArrayBuffer[]> {
  const blob = await invoke<ArrayBuffer>("comfy_bake", {
    url,
    workflow,
    imageB64: toBase64(image),
    filename,
  });
  return unframe(blob);
}

/** Exported for the wire-format check against `frame_images` in comfy.rs. */
export function unframe(blob: ArrayBuffer): ArrayBuffer[] {
  if (blob.byteLength < 4) throw new Error("Leere Antwort von ComfyUI");
  const view = new DataView(blob);
  const count = view.getUint32(0, true);
  const lengths: number[] = [];
  for (let i = 0; i < count; i++) {
    lengths.push(view.getUint32(4 + i * 4, true));
  }
  let offset = 4 + count * 4;
  const expected = lengths.reduce((n, l) => n + l, offset);
  if (expected !== blob.byteLength) {
    throw new Error(
      `Antwort unvollständig: ${blob.byteLength} statt ${expected} Bytes`,
    );
  }
  return lengths.map((len) => {
    const slice = blob.slice(offset, offset + len);
    offset += len;
    return slice;
  });
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  // chunked: String.fromCharCode blows the argument limit on a whole image
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
