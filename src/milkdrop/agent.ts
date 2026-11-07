// Preset editing by a local language model (Ollama, LM Studio, llama.cpp —
// anything with an OpenAI-compatible chat endpoint). The model sees the
// preset's code and baseVals plus a cheat sheet, and answers with a JSON
// patch; vizzy applies it to a copy of the draft and probe-renders it.
//
// Expectation, honestly: small models mostly vary constants and baseVals,
// which is fine for "colder", "slower", "more zoom". New algorithms need a
// larger model — or the Claude Code bridge.

import { invoke } from "@tauri-apps/api/core";
import { EEL_REFERENCE } from "./reference";
import { CODE_PARTS, CODE_FIELD, makePreset, type VizzyPreset } from "./vpreset";

const LS = "vizzy.llm.v1";
export type LlmConfig = { url: string; model: string };

export function loadLlmConfig(): LlmConfig {
  try {
    return { url: "http://127.0.0.1:11434", model: "", ...JSON.parse(localStorage.getItem(LS) ?? "{}") };
  } catch {
    return { url: "http://127.0.0.1:11434", model: "" };
  }
}

export function saveLlmConfig(c: LlmConfig) {
  try {
    localStorage.setItem(LS, JSON.stringify(c));
  } catch {
    // ignore
  }
}

export function listModels(url: string): Promise<string[]> {
  return invoke<string[]>("llm_models", { url });
}

const SYSTEM = `You edit MilkDrop visualizer presets (as used by Butterchurn).
A preset has baseVals (numbers), per-frame equations (EEL, run once per frame),
per-pixel equations (EEL, run per mesh vertex), and warp/comp shaders (MilkDrop
HLSL-style GLSL inside "shader_body { ... }", ret = output color).
EEL rules: statements end with ";", no if-statements (use if(cond,a,b)),
comparisons via above/below/equal, variables need no declaration.

Answer with ONE JSON object and nothing else:
{"note": "one sentence on what you changed",
 "baseVals": {"name": number, ...},     // only the values you change
 "frame": "full new per-frame code",     // optional, only if you change it
 "pixel": "full new per-pixel code",     // optional
 "warp": "full new warp shader",         // optional
 "comp": "full new comp shader"}         // optional
Keep everything you don't need to change out of the answer. Keep the code
working: a preset that fails to compile is thrown away.`;

function cheatSheet(): string {
  return EEL_REFERENCE.map(([k, v]) => `${k}: ${v}`).join("\n");
}

function presetText(composed: Record<string, unknown>): string {
  const bv = composed.baseVals as Record<string, unknown> | undefined;
  const nums = Object.entries(bv ?? {})
    .filter(([, v]) => typeof v === "number")
    .map(([k, v]) => `${k}=${Number(v).toFixed(3)}`)
    .join(", ");
  const code = CODE_PARTS.filter((p) => p !== "init")
    .map((p) => `--- ${p} ---\n${String(composed[CODE_FIELD[p]] ?? "").slice(0, 6000)}`)
    .join("\n\n");
  return `baseVals: ${nums}\n\n${code}`;
}

/** First balanced {...} block in the text (models like to add prose). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const src = fenced ? fenced[1] : text;
  const start = src.indexOf("{");
  if (start < 0) throw new Error("keine JSON-Antwort");
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return JSON.parse(src.slice(start, i + 1));
  }
  throw new Error("JSON-Antwort unvollständig");
}

export type AgentResult = { preset: VizzyPreset; note: string; raw: string };

export async function askAgent(
  cfg: LlmConfig,
  draft: VizzyPreset,
  composed: Record<string, unknown>,
  instruction: string,
  parentKey: string,
): Promise<AgentResult> {
  const raw = await invoke<string>("llm_chat", {
    url: cfg.url,
    model: cfg.model,
    temperature: 0.6,
    messages: [
      { role: "system", content: `${SYSTEM}\n\nVariables:\n${cheatSheet()}` },
      { role: "user", content: `Preset:\n${presetText(composed)}\n\nTask: ${instruction}` },
    ],
  });
  const patch = extractJson(raw) as Record<string, unknown>;
  const next = makePreset(draft.name, draft.base, {
    parts: JSON.parse(JSON.stringify(draft.parts)),
    overrides: { ...draft.overrides },
    lineage: { parents: [parentKey], op: "ai", at: Date.now(), note: String(patch.note ?? instruction).slice(0, 200) },
  });
  next.id = draft.id;
  if (patch.baseVals && typeof patch.baseVals === "object") {
    for (const [k, v] of Object.entries(patch.baseVals as Record<string, unknown>)) {
      const n = Number(v);
      if (Number.isFinite(n)) next.overrides[k] = n;
    }
  }
  for (const part of ["frame", "pixel", "warp", "comp"] as const) {
    const v = patch[part];
    if (typeof v === "string" && v.trim()) next.parts[part] = { inline: v };
  }
  return { preset: next, note: String(patch.note ?? ""), raw };
}
