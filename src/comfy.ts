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
 * (`"(golden hour:__VIZZY_X__)"`) and as a node input, where a token standing
 * alone as a value — `"denoise": "__VIZZY_Y__"` — loses its quotes along with
 * the token and arrives as a real JSON number. Writing the quotes keeps the
 * template parseable as it sits in the editor, which is what the panel
 * validates.
 */
export const X_TOKEN = "__VIZZY_X__";
export const Y_TOKEN = "__VIZZY_Y__";
export const INDEX_TOKEN = "__VIZZY_INDEX__";

export const DEFAULT_COMFY_URL = "http://127.0.0.1:8188";

/**
 * Checkpoint `DEFAULT_VARIANT_WORKFLOW` loads.
 *
 * A name, not a capability: ComfyUI only offers what is on that machine, and
 * nothing here can conjure a missing file. This one is an SDXL photo model,
 * which is what the variant workflow is tuned for — a different base wants
 * different steps and cfg. If your install does not have it, the panel's
 * workflow field is the place to change it; `/object_info` on the server
 * lists what it does have.
 */
export const DEFAULT_CHECKPOINT =
  "Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors";

/** Weights `DEFAULT_DEPTH_WORKFLOW` expects in `models/geometry_estimation/`. */
export const DA3_MODEL_FILE = "depth_anything_3_mono_large.safetensors";
export const DA3_MODEL_URL =
  "https://huggingface.co/Comfy-Org/Depth-Anything-3/resolve/main/geometry_estimation/" +
  DA3_MODEL_FILE;

/**
 * Depth bake in ComfyUI's API format (the "Export (API)" flavour, not the
 * editor's own save format).
 *
 * Core nodes only: ComfyUI 0.44 ships Depth Anything 3 itself, so no custom
 * node pack is needed — only the weights above, dropped into
 * `models/geometry_estimation/`. The *mono* variant is the one that predicts
 * a sky mask, and the sky is what decides whether a landscape unfolds or
 * tears: `v2_style` pins sky pixels to black (far) instead of letting a
 * single bright cloud define the near end of the range.
 *
 * `DA3Render` renders near = white, which is the polarity the parallax shader
 * already assumes — so "Tiefenkarte invertieren" stays off.
 *
 * Only the `__VIZZY_INPUT_IMAGE__` placeholder and a single image-saving node
 * at the end are required; swap the middle nodes for any depth estimator you
 * prefer. Measured on an RTX 5070: ~1 s for a 1216×832 image at resolution
 * 1008, once the weights are resident — the first run pays the load.
 */
export const DEFAULT_DEPTH_WORKFLOW = JSON.stringify(
  {
    "1": {
      class_type: "LoadImage",
      inputs: { image: IMAGE_TOKEN, upload: "image" },
    },
    "2": {
      class_type: "LoadDA3Model",
      inputs: { model_name: DA3_MODEL_FILE, weight_dtype: "default" },
    },
    "3": {
      class_type: "DA3Inference",
      inputs: {
        da3_model: ["2", 0],
        image: ["1", 0],
        // longest side the model runs at, must be a multiple of 14;
        // the result is upsampled back to the picture's own size
        resolution: 1008,
        resize_method: "upper_bound_resize",
        mode: "mono",
      },
    },
    "4": {
      class_type: "DA3Render",
      inputs: {
        da3_geometry: ["3", 0],
        output: "depth",
        // ComfyUI namespaces a dynamic combo's dependent inputs under the
        // combo's own name; written flat, the server rejects the prompt with
        // "Required input is missing: normalization".
        "output.normalization": "v2_style",
        // a no-op next to v2_style, which already keeps the sky out of its
        // quantiles and then pins it to black
        "output.apply_sky_clip": false,
      },
    },
    "5": {
      class_type: "SaveImage",
      inputs: { images: ["4", 0], filename_prefix: "vizzy_depth" },
    },
  },
  null,
  2,
);

/**
 * Variant bake for the morph grid: one cell of the grid per run.
 *
 * Core nodes only, so it works on a bare ComfyUI. Each axis is a crossfade
 * between two opposed prompts via `ConditioningAverage`, with the axis value
 * as the mix: `__VIZZY_X__` goes cold moonlight → warm gold (the grid's
 * timbre axis), `__VIZZY_Y__` goes calm → thunderstorm (its energy axis).
 *
 * The first version of this put both axes on prompt *weights* inside one
 * sentence. It baked nine near-identical pictures: a weight on a sub-phrase,
 * under a denoise low enough to keep the composition, barely moves SDXL at
 * all. Interpolating whole conditionings is the lever that actually pulls —
 * and because the two endpoints are encoded once and only mixed per cell,
 * neighbouring cells stay close, which is what the blending needs.
 *
 * The seed is a literal, so every cell shares it: that shared structure is
 * what makes the blends read as one picture changing rather than as several
 * pictures stacked. `denoise` is the other half of that bargain — high enough
 * for the prompt to bite, low enough for the composition to survive. 0.45
 * holds a landscape; faces are another matter, and img2img will rearrange
 * them at any strength worth using.
 *
 * The picture is scaled to one megapixel first. Not a nicety: a photo
 * straight off a camera is 24 MP, and SDXL's VAE would run out of VRAM long
 * before the sampler ever started.
 *
 * `ckpt_name` has to match a checkpoint the ComfyUI you point at actually
 * has — see `DEFAULT_CHECKPOINT`.
 */
export const DEFAULT_VARIANT_WORKFLOW = JSON.stringify(
  {
    "1": {
      class_type: "LoadImage",
      inputs: { image: IMAGE_TOKEN, upload: "image" },
    },
    "2": {
      class_type: "ImageScaleToTotalPixels",
      inputs: {
        image: ["1", 0],
        upscale_method: "lanczos",
        megapixels: 1.0,
        resolution_steps: 8,
      },
    },
    "3": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: DEFAULT_CHECKPOINT },
    },
    // the four poles: X runs 4 → 5, Y runs 6 → 7
    "4": {
      class_type: "CLIPTextEncode",
      inputs: {
        clip: ["3", 1],
        text: "cold blue moonlight, deep shadows, desaturated, night",
      },
    },
    "5": {
      class_type: "CLIPTextEncode",
      inputs: {
        clip: ["3", 1],
        text: "warm golden sunlight, long shadows, glowing amber light, sunset",
      },
    },
    "6": {
      class_type: "CLIPTextEncode",
      inputs: { clip: ["3", 1], text: "calm still air, clear sky, serene" },
    },
    "7": {
      class_type: "CLIPTextEncode",
      inputs: {
        clip: ["3", 1],
        text: "violent thunderstorm, black churning clouds, heavy rain, dramatic",
      },
    },
    "8": {
      class_type: "ConditioningAverage",
      inputs: {
        conditioning_to: ["5", 0],
        conditioning_from: ["4", 0],
        conditioning_to_strength: X_TOKEN,
      },
    },
    "9": {
      class_type: "ConditioningAverage",
      inputs: {
        conditioning_to: ["7", 0],
        conditioning_from: ["6", 0],
        conditioning_to_strength: Y_TOKEN,
      },
    },
    "10": {
      class_type: "ConditioningCombine",
      inputs: { conditioning_1: ["8", 0], conditioning_2: ["9", 0] },
    },
    "11": {
      class_type: "CLIPTextEncode",
      inputs: { clip: ["3", 1], text: "text, watermark, blurry, deformed" },
    },
    "12": {
      class_type: "VAEEncode",
      inputs: { pixels: ["2", 0], vae: ["3", 2] },
    },
    "13": {
      class_type: "KSampler",
      inputs: {
        model: ["3", 0],
        positive: ["10", 0],
        negative: ["11", 0],
        latent_image: ["12", 0],
        // same seed in every cell — the variants must share structure
        seed: 1234,
        steps: 24,
        cfg: 6.5,
        sampler_name: "dpmpp_2m",
        scheduler: "karras",
        denoise: 0.55,
      },
    },
    "14": { class_type: "VAEDecode", inputs: { samples: ["13", 0], vae: ["3", 2] } },
    "15": {
      class_type: "SaveImage",
      inputs: { images: ["14", 0], filename_prefix: `vizzy_cell_${INDEX_TOKEN}` },
    },
  },
  null,
  2,
);

/** The four files the Qwen-Image-Edit template loads. */
export const QWEN_MODELS = {
  unet: "qwen_image_edit_2511_fp8mixed.safetensors",
  clip: "qwen_2.5_vl_7b_fp8_scaled.safetensors",
  vae: "qwen_image_vae.safetensors",
  lora: "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors",
} as const;

/** One corner of the grid, as an instruction. Kept to one shape and roughly
 *  one length: `ConditioningAverage` truncates the shorter conditioning and
 *  zero-pads the rest, so wildly different prompt lengths blend badly. */
const qwenCorner = (light: string, weather: string) =>
  `Relight this scene with ${light} under ${weather}. ` +
  `Keep every shape exactly where it is.`;

/**
 * Variant bake through Qwen-Image-Edit 2511 — an instruction-following image
 * editor rather than a denoiser.
 *
 * Why it beats the SDXL template at this particular job: img2img destroys the
 * picture and rebuilds it from a prompt, so composition survives only because
 * `denoise` is held low, and "low enough to keep the frame" fights "high
 * enough to change the mood". An edit model takes the picture as a condition
 * (the reference latents inside the conditioning, which is why `denoise` is
 * 1.0 here and the encoded latent only supplies the shape) and performs an
 * instruction on it. Structure holds by construction, and measured on the
 * same test scene it holds *far* tighter — individual rocks in a river stay
 * put while the light changes completely.
 *
 * The two axes are a **bilinear blend of four corner instructions**: X mixes
 * each row's two lighting poles, then Y mixes the two rows. That mirrors what
 * the morph shader does with the baked frames, one stage earlier. It also
 * avoids `ConditioningCombine`, which would append a second condition and
 * with it a second copy of the reference latents.
 *
 * Costs four text encodes of a 7B VL model, plus one for the empty negative
 * — but only once per bake, not once per cell: their inputs never change, so
 * ComfyUI serves them from its cache and only the blend weights differ. On
 * an RTX 5070 with 12 GB that shows as 68 s, 97 s, 272 s for the first three
 * cells while the models settle, then a steady 26 s. The Lightning LoRA
 * keeps sampling to four steps at cfg 1.
 *
 * The blend is not perceptually linear: at `x = 0.5` the result already sits
 * close to the warm pole, so the cold end occupies roughly the first third
 * of the axis. A larger grid samples that better than a wider range would.
 */
export const QWEN_VARIANT_WORKFLOW = JSON.stringify(
  {
    "1": {
      class_type: "LoadImage",
      inputs: { image: IMAGE_TOKEN, upload: "image" },
    },
    // snaps to a resolution the model was trained on, keeping the aspect
    "2": { class_type: "FluxKontextImageScale", inputs: { image: ["1", 0] } },

    "3": {
      class_type: "UNETLoader",
      inputs: { unet_name: QWEN_MODELS.unet, weight_dtype: "default" },
    },
    "4": {
      class_type: "ModelSamplingAuraFlow",
      inputs: { model: ["3", 0], shift: 3.1 },
    },
    "5": {
      class_type: "CFGNorm",
      inputs: { model: ["4", 0], strength: 1.0, pre_cfg: false },
    },
    "6": {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        model: ["5", 0],
        lora_name: QWEN_MODELS.lora,
        strength_model: 1.0,
      },
    },
    "7": {
      class_type: "CLIPLoader",
      inputs: {
        clip_name: QWEN_MODELS.clip,
        type: "qwen_image",
        device: "default",
      },
    },
    "8": { class_type: "VAELoader", inputs: { vae_name: QWEN_MODELS.vae } },

    // the four corners: 9/10 the calm row, 11/12 the storm row
    "9": {
      class_type: "TextEncodeQwenImageEditPlus",
      inputs: {
        clip: ["7", 0],
        vae: ["8", 0],
        image1: ["2", 0],
        prompt: qwenCorner("cold blue moonlight", "a calm clear sky"),
      },
    },
    "10": {
      class_type: "TextEncodeQwenImageEditPlus",
      inputs: {
        clip: ["7", 0],
        vae: ["8", 0],
        image1: ["2", 0],
        prompt: qwenCorner("warm golden sunset light", "a calm clear sky"),
      },
    },
    "11": {
      class_type: "TextEncodeQwenImageEditPlus",
      inputs: {
        clip: ["7", 0],
        vae: ["8", 0],
        image1: ["2", 0],
        prompt: qwenCorner("cold blue storm light", "a violent thunderstorm"),
      },
    },
    "12": {
      class_type: "TextEncodeQwenImageEditPlus",
      inputs: {
        clip: ["7", 0],
        vae: ["8", 0],
        image1: ["2", 0],
        prompt: qwenCorner("warm golden light", "a violent thunderstorm"),
      },
    },

    // X across the calm row, X across the storm row, then Y between them
    "13": {
      class_type: "ConditioningAverage",
      inputs: {
        conditioning_to: ["10", 0],
        conditioning_from: ["9", 0],
        conditioning_to_strength: X_TOKEN,
      },
    },
    "14": {
      class_type: "ConditioningAverage",
      inputs: {
        conditioning_to: ["12", 0],
        conditioning_from: ["11", 0],
        conditioning_to_strength: X_TOKEN,
      },
    },
    "15": {
      class_type: "ConditioningAverage",
      inputs: {
        conditioning_to: ["14", 0],
        conditioning_from: ["13", 0],
        conditioning_to_strength: Y_TOKEN,
      },
    },
    "16": {
      class_type: "FluxKontextMultiReferenceLatentMethod",
      inputs: {
        conditioning: ["15", 0],
        reference_latents_method: "index_timestep_zero",
      },
    },

    "17": {
      class_type: "TextEncodeQwenImageEditPlus",
      inputs: { clip: ["7", 0], vae: ["8", 0], image1: ["2", 0], prompt: "" },
    },
    "18": {
      class_type: "FluxKontextMultiReferenceLatentMethod",
      inputs: {
        conditioning: ["17", 0],
        reference_latents_method: "index_timestep_zero",
      },
    },

    "19": {
      class_type: "VAEEncode",
      inputs: { pixels: ["2", 0], vae: ["8", 0] },
    },
    "20": {
      class_type: "KSampler",
      inputs: {
        model: ["6", 0],
        positive: ["16", 0],
        negative: ["18", 0],
        latent_image: ["19", 0],
        // same seed in every cell, as in the SDXL template
        seed: 1234,
        // four steps at cfg 1 is the Lightning LoRA's bargain; drop the LoRA
        // (node 6) and this wants roughly 40 steps at cfg 4
        steps: 4,
        cfg: 1.0,
        sampler_name: "euler",
        scheduler: "simple",
        // the picture enters through the conditioning, not the latent
        denoise: 1.0,
      },
    },
    "21": {
      class_type: "VAEDecode",
      inputs: { samples: ["20", 0], vae: ["8", 0] },
    },
    "22": {
      class_type: "SaveImage",
      inputs: { images: ["21", 0], filename_prefix: `vizzy_cell_${INDEX_TOKEN}` },
    },
  },
  null,
  2,
);

/**
 * The variant templates the panel offers. Both are a starting point for the
 * workflow editor, not a menu of modes — whatever ends up in the text area is
 * what runs.
 */
export type VariantPreset = {
  id: string;
  label: string;
  note: string;
  workflow: string;
};

export const VARIANT_PRESETS: VariantPreset[] = [
  {
    id: "qwen",
    label: "Qwen-Image-Edit",
    note:
      "Ein Bild-Editor: die Komposition bleibt von selbst stehen, nicht weil " +
      "eine Stärke gedrosselt wurde. Braucht UNET, CLIP, VAE und die " +
      "Lightning-LoRA von Qwen-Image-Edit 2511.",
    workflow: QWEN_VARIANT_WORKFLOW,
  },
  {
    id: "sdxl",
    label: "SDXL img2img",
    note:
      "Genügsamer: ein einzelnes SDXL-Checkpoint reicht. Hält die Komposition " +
      "über ein niedriges denoise, verändert die Stimmung dafür weniger weit.",
    workflow: DEFAULT_VARIANT_WORKFLOW,
  },
];

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
  // the default workflow spends these as crossfades between two prompts, so
  // the full 0..1 is meaningful: 0 is one pole, 1 the other. A template that
  // spends them as prompt weights instead wants to start above 0, since a
  // weight of 0 deletes its term.
  xFrom: 0,
  xTo: 1,
  yFrom: 0,
  yTo: 1,
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
 *
 * A token that is a value all by itself (`"strength": "__VIZZY_X__"`) is
 * replaced together with its quotes, so the node receives a number rather
 * than a string. Tokens sitting inside a longer string — a prompt weight —
 * are replaced in place and the string stays a string.
 */
export function fillAxes(
  workflow: string,
  cell: { index: number; x: number; y: number },
): string {
  const subst = (text: string, token: string, value: string) =>
    text.split(`"${token}"`).join(value).split(token).join(value);
  let out = subst(workflow, X_TOKEN, cell.x.toFixed(3));
  out = subst(out, Y_TOKEN, cell.y.toFixed(3));
  return subst(out, INDEX_TOKEN, String(cell.index + 1));
}

export type BakeKind = "depth" | "variants";

const URL_KEY = "vizzy.comfy.url";
const WORKFLOW_KEY: Record<BakeKind, string> = {
  depth: "vizzy.comfy.workflow.depth",
  variants: "vizzy.comfy.workflow.variants",
};

export const DEFAULT_WORKFLOW: Record<BakeKind, string> = {
  depth: DEFAULT_DEPTH_WORKFLOW,
  // the first preset wins: quality over speed, which for a bake that runs
  // once and is then played forever is the easy call
  variants: VARIANT_PRESETS[0].workflow,
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
