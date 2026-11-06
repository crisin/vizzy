// Frontend side of the ComfyUI bake. The HTTP work happens in Rust
// (src-tauri/src/comfy.rs) because ComfyUI serves no CORS headers by
// default; this module only holds the settings, the workflow template and
// the invoke wrappers.

import { invoke } from "@tauri-apps/api/core";

export const IMAGE_TOKEN = "__VIZZY_INPUT_IMAGE__";

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
 * Variant bake for the morph grid: N takes on the same picture.
 *
 * Core nodes only — `RepeatLatentBatch` copies the encoded image N times and
 * the sampler gives each batch index its own noise, so one run yields N
 * images that share the composition and differ in detail. That is the part
 * the morph grid needs, and it works on a bare ComfyUI with no custom nodes.
 *
 * What it does *not* give you is a meaningful order. The grid's axes read
 * left-to-right as timbre and top-to-bottom as energy, and batch noise is
 * unordered — so the surface will be coherent but arbitrary. For axes that
 * mean something, vary a prompt weight or an IP-Adapter weight per output
 * instead; that is install-specific, which is why it is not the default.
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
      inputs: { clip: ["2", 1], text: "same scene, shifting mood and light" },
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
      class_type: "RepeatLatentBatch",
      inputs: { samples: ["5", 0], amount: 9 },
    },
    "7": {
      class_type: "KSampler",
      inputs: {
        model: ["2", 0],
        positive: ["3", 0],
        negative: ["4", 0],
        latent_image: ["6", 0],
        seed: 1234,
        steps: 20,
        cfg: 6,
        sampler_name: "dpmpp_2m",
        scheduler: "karras",
        // low enough that the composition survives, high enough to differ
        denoise: 0.45,
      },
    },
    "8": { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["2", 2] } },
    "9": {
      class_type: "SaveImage",
      inputs: { images: ["8", 0], filename_prefix: "vizzy_variant" },
    },
  },
  null,
  2,
);

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
