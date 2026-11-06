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

const URL_KEY = "vizzy.comfy.url";
const WORKFLOW_KEY = "vizzy.comfy.workflow.depth";

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

export function loadDepthWorkflow(): string {
  try {
    return localStorage.getItem(WORKFLOW_KEY) || DEFAULT_DEPTH_WORKFLOW;
  } catch {
    return DEFAULT_DEPTH_WORKFLOW;
  }
}

export function saveDepthWorkflow(json: string) {
  try {
    if (json.trim() === DEFAULT_DEPTH_WORKFLOW.trim()) {
      localStorage.removeItem(WORKFLOW_KEY);
    } else {
      localStorage.setItem(WORKFLOW_KEY, json);
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
 * Run `workflow` over `image` and return the first image it saved.
 *
 * The bytes travel as base64: Tauri's IPC payload is JSON, where a byte array
 * would be serialised as a list of numbers — several times the size.
 */
export async function comfyBake(
  url: string,
  workflow: string,
  image: ArrayBuffer,
  filename: string,
): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("comfy_bake", {
    url,
    workflow,
    imageB64: toBase64(image),
    filename,
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
