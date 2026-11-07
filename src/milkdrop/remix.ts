// Remix operators on Vizzy presets: mutate and cross. Both produce new
// presets that remember their parents (lineage), and both are only as good as
// the filter behind them — `probe` renders a candidate for a moment and
// throws away what traps, stays black or is a flat wash.

import { TWEAK_DEFS } from "../mdTweaks";
import { MilkdropEngine } from "./engine";
import {
  CODE_FIELD,
  CODE_PARTS,
  makePreset,
  type Part,
  type VizzyPreset,
} from "./vpreset";

type Bc = Record<string, unknown> & { baseVals?: Record<string, unknown> };

function rng(seed: number) {
  let x = seed | 0 || 0x9e3779b9;
  const next = () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
  const gauss = () => {
    const u = Math.max(1e-9, next());
    const v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  return { next, gauss };
}

/** Width of a "normal" nudge per baseVal, as a fraction of its slider range. */
const SPREAD: Record<string, number> = {
  zoom: 0.06, rot: 0.08, warp: 0.25, decay: 0.03, cx: 0.06, cy: 0.06,
  sx: 0.05, sy: 0.05, echo_zoom: 0.08, echo_alpha: 0.2, wave_a: 0.15,
  wave_scale: 0.15, wave_r: 0.25, wave_g: 0.25, wave_b: 0.25, gammaadj: 0.1,
};

/**
 * Nudges numeric literals in EEL/GLSL text. Only literals with a decimal
 * point are touched: integers in Milkdrop code are loop counts, buffer
 * indices and switch values, and changing those breaks things rather than
 * varying them.
 */
export function mutateCode(code: string, strength: number, seed: number): string {
  const r = rng(seed);
  return code.replace(/(?<![\w.])(\d+\.\d+|\.\d+)(?![\w.])/g, (m) => {
    if (r.next() > 0.35 * strength) return m;
    const v = Number(m);
    const n = v * (1 + r.gauss() * 0.3 * strength);
    const digits = Math.max(2, (m.split(".")[1] ?? "").length);
    return n.toFixed(digits);
  });
}

export function mutate(
  src: VizzyPreset,
  composed: Bc,
  opts: { strength: number; code: boolean; seed: number; parentKey: string },
): VizzyPreset {
  const r = rng(opts.seed);
  const bv = composed.baseVals ?? {};
  const overrides = { ...src.overrides };
  for (const d of TWEAK_DEFS) {
    const v = overrides[d.key] ?? bv[d.key];
    if (typeof v !== "number" || d.step >= 1) continue;
    if (r.next() > 0.6) continue;
    const spread = (SPREAD[d.key] ?? 0.08) * (d.max - d.min) * opts.strength;
    const n = Math.min(d.max, Math.max(d.min, v + r.gauss() * spread));
    overrides[d.key] = Math.round(n / d.step) * d.step;
  }
  const parts = JSON.parse(JSON.stringify(src.parts)) as VizzyPreset["parts"];
  if (opts.code) {
    for (const part of CODE_PARTS) {
      const text = composed[CODE_FIELD[part]];
      if (typeof text !== "string" || !text.trim()) continue;
      if (r.next() > 0.5) continue;
      const next = mutateCode(text, opts.strength, opts.seed + part.length * 101);
      if (next !== text) parts[part] = { inline: next };
    }
  }
  return makePreset(`${src.name} ~`, src.base, {
    parts,
    overrides,
    lineage: { parents: [opts.parentKey], op: "mutate", at: Date.now() },
  });
}

/** Part-wise crossing: each slot from A (as it is) or B (by reference). */
export function cross(
  a: VizzyPreset,
  aKey: string,
  bKey: string,
  seed: number,
): VizzyPreset {
  const r = rng(seed);
  const parts = JSON.parse(JSON.stringify(a.parts)) as VizzyPreset["parts"];
  const fromB = { from: bKey };
  let tookB = 0;
  const pick = () => {
    const b = r.next() < 0.5;
    if (b) tookB++;
    return b;
  };
  if (pick()) parts.baseVals = fromB;
  for (const p of CODE_PARTS) if (pick()) parts[p] = fromB;
  for (const list of ["waves", "shapes"] as const) {
    const slots: (Part<unknown> | null)[] = [...(parts[list] ?? [null, null, null, null])];
    for (let i = 0; i < 4; i++) if (pick()) slots[i] = fromB;
    parts[list] = slots;
  }
  // never a clone of either parent
  if (tookB === 0) parts.comp = fromB;
  return makePreset(`${a.name} × ${bKey.replace(/^user:/, "")}`, a.base, {
    parts,
    overrides: { ...a.overrides },
    lineage: { parents: [aKey, bKey], op: "cross", at: Date.now() },
  });
}

/* ---------------------------------------------------------------- probe */

let probeEngine: MilkdropEngine | null = null;
let probeChain: Promise<unknown> = Promise.resolve();

export type ProbeResult = { ok: boolean; reason: string; thumb: string; errors?: string };

/**
 * Renders a candidate for ~2 s of simulated time at a small size and judges
 * it: traps, compile errors, black and flat pictures fail. Serialised —
 * one probe engine for the whole app.
 */
export function probe(preset: unknown): Promise<ProbeResult> {
  const run = async (): Promise<ProbeResult> => {
    if (!probeEngine) {
      const c = document.createElement("canvas");
      c.width = 192;
      c.height = 108;
      probeEngine = new MilkdropEngine(c);
    }
    const eng = probeEngine;
    if (!(await eng.load("probe", preset, 0))) {
      return { ok: false, reason: `kompiliert nicht: ${eng.error}`, thumb: "", errors: eng.error };
    }
    const bytes = new Uint8Array(1024);
    let traps = 0;
    for (let i = 0; i < 70; i++) {
      const t = i / 30;
      for (let j = 0; j < bytes.length; j++) {
        const s = t + j / 44100;
        const kick = Math.exp(-((s * 2) % 1) * 10) * Math.sin(2 * Math.PI * 60 * s);
        const hat = (Math.random() * 2 - 1) * 0.2;
        bytes[j] = (Math.max(-1, Math.min(1, kick * 0.8 + hat)) * 127 + 128) | 0;
      }
      if (!eng.render(bytes, 1 / 30)) traps++;
      if (i % 20 === 19) await new Promise((r) => setTimeout(r, 0));
    }
    const small = document.createElement("canvas");
    small.width = 16;
    small.height = 9;
    const ctx = small.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(eng.canvas, 0, 0, 16, 9);
    const px = ctx.getImageData(0, 0, 16, 9).data;
    let sum = 0;
    let sum2 = 0;
    for (let k = 0; k < px.length; k += 4) {
      const g = (px[k] + px[k + 1] + px[k + 2]) / (3 * 255);
      sum += g;
      sum2 += g * g;
    }
    const n = px.length / 4;
    const mean = sum / n;
    const sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
    const thumb = eng.canvas.toDataURL("image/webp", 0.7);
    const errors = eng.error;
    if (traps > 2) return { ok: false, reason: "trappt", thumb, errors };
    if (mean < 0.015) return { ok: false, reason: "schwarz", thumb, errors };
    if (mean > 0.97) return { ok: false, reason: "weiß", thumb, errors };
    if (sd < 0.01) return { ok: false, reason: "flach", thumb, errors };
    return { ok: true, reason: "", thumb, errors };
  };
  const next = probeChain.then(run, run);
  probeChain = next.catch(() => undefined);
  return next;
}
