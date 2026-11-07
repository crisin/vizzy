// Preview generator for the preset library.
//
// Every preset is rendered offscreen against a synthetic track and leaves
// behind one still and a 12-frame clip (a single-row sprite sheet). The clip
// is a little story told the same way for every preset so they compare:
//
//   frames 0–2   leise      — quiet passage
//   frames 3–5   laut       — the same groove, loud
//   frames 6–7   drop       — a breath of near-silence, then a hard hit
//   frames 8–9   verlauf    — further along in time, nothing changed
//   frames 10–11 variante   — the preset reloaded with scattered tweaks
//
// The scattered overrides are stored with the clip, so a variant can be
// taken over with one click. While rendering, motion and brightness are
// measured; across all presets that sorts them into rough energy thirds,
// which the library offers as tag suggestions.
//
// Time is simulated (fixed 1/30 s steps), not waited for, and the work is
// spread over animation frames so the main picture keeps running.

import { MilkdropEngine } from "./engine";
import { hashString } from "./catalog";
import { MD_PREVIEW_STORE, withStore } from "../idb";
import { TWEAK_DEFS } from "../mdTweaks";

export const FRAME_W = 256;
export const FRAME_H = 144;
export const CLIP_FRAMES = 12;
export const FRAME_LABELS = [
  "leise", "leise", "leise",
  "laut", "laut", "laut",
  "drop", "drop",
  "verlauf", "verlauf",
  "variante 1", "variante 2",
];
export const VARIANT_FRAMES = [10, 11];
const GEN_VERSION = 1;
const STEP = 1 / 30;
/** milliseconds of preview work per real animation frame — leaves the rest
 *  of a 60 Hz frame to the main picture */
const BUDGET_MS = 7;

export type PreviewRecord = {
  key: string;
  presetKey: string;
  still: Blob;
  sheet: Blob;
  variants: Record<string, number>[];
  motion: number;
  brightness: number;
  createdAt: number;
};

export function cacheKey(presetKey: string, preset: unknown): string {
  return `${presetKey}|${hashString(JSON.stringify(preset))}|${GEN_VERSION}`;
}

export function loadAllPreviews(): Promise<PreviewRecord[]> {
  return withStore<PreviewRecord[]>(MD_PREVIEW_STORE, "readonly", (s) => s.getAll());
}

function savePreview(r: PreviewRecord): Promise<unknown> {
  return withStore(MD_PREVIEW_STORE, "readwrite", (s) => s.put(r));
}

export function deletePreview(key: string): Promise<unknown> {
  return withStore(MD_PREVIEW_STORE, "readwrite", (s) => s.delete(key));
}

/* ------------------------------------------------------------ synth audio */

/** A small deterministic groove: kick, offbeat hats, a slow sweep. */
function synth(out: Uint8Array, t: number, level: number, kickBoost = 1) {
  const bpm = 124;
  const beatDur = 60 / bpm;
  const sr = 44100;
  let seed = Math.floor(t * 1000) | 0;
  for (let j = 0; j < out.length; j++) {
    const s = t + j / sr;
    const bt = (s / beatDur) % 1;
    const et = ((s / beatDur) * 2) % 1;
    const kick = Math.exp(-bt * 12) * Math.sin(2 * Math.PI * (50 + 100 * Math.exp(-bt * 25)) * s);
    seed = (seed * 1664525 + 1013904223) | 0;
    const noise = ((seed >>> 8) / 0x1000000) * 2 - 1;
    const hat = et > 0.5 ? Math.exp(-(et - 0.5) * 30) * noise * 0.35 : 0;
    const sweep = 0.25 * Math.sin(2 * Math.PI * (220 + 180 * Math.sin(s * 0.4)) * s);
    const v = level * (kick * 0.9 * kickBoost + hat + sweep);
    out[j] = Math.max(0, Math.min(255, (Math.max(-1, Math.min(1, v)) * 127 + 128) | 0));
  }
}

/* -------------------------------------------------------------- scatter */

function rand(seed: number): () => number {
  let x = seed | 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 100000) / 100000;
  };
}

/** Plausible neighbours of a preset: a few motion values nudged. */
function scatter(baseVals: Record<string, unknown>, seed: number): Record<string, number> {
  const r = rand(seed);
  const out: Record<string, number> = {};
  const nudge: Record<string, (v: number) => number> = {
    zoom: (v) => v + (r() - 0.5) * 0.12,
    rot: (v) => v + (r() - 0.5) * 0.08,
    warp: (v) => v * (0.4 + r() * 1.8),
    decay: (v) => v + (r() - 0.5) * 0.04,
    echo_zoom: (v) => v + (r() - 0.5) * 0.2,
  };
  for (const def of TWEAK_DEFS) {
    const f = nudge[def.key];
    const v = baseVals[def.key];
    if (!f || typeof v !== "number") continue;
    const n = Math.min(def.max, Math.max(def.min, f(v)));
    out[def.key] = Math.round(n / def.step) * def.step;
  }
  return out;
}

/* ------------------------------------------------------------ generator */

type Job = { presetKey: string; preset: unknown; key: string };

type Phase = {
  seconds: number;
  level: number;
  kick?: number;
  /** capture frame index at these offsets (s) into the phase */
  captures?: [number, number][];
  /** measure motion during this phase */
  measure?: boolean;
  /** reload with variant n before this phase */
  variant?: number;
};

const SCRIPT: Phase[] = [
  { seconds: 2, level: 0.6 },
  { seconds: 2, level: 0.15, captures: [[0.6, 0], [1.3, 1], [1.95, 2]] },
  { seconds: 2, level: 0.9, captures: [[0.6, 3], [1.3, 4], [1.95, 5]], measure: true },
  { seconds: 0.6, level: 0.03 },
  { seconds: 1.2, level: 1, kick: 1.6, captures: [[0.15, 6], [0.8, 7]] },
  { seconds: 3, level: 0.75, captures: [[1.5, 8], [2.95, 9]], measure: true },
  { variant: 0, seconds: 1.5, level: 0.8, captures: [[1.45, 10]] },
  { variant: 1, seconds: 1.5, level: 0.8, captures: [[1.45, 11]] },
];

export type GeneratorStatus = { done: number; total: number; current: string };

export class PreviewGenerator {
  private queue: Job[] = [];
  private engine: MilkdropEngine | null = null;
  private running = false;
  private raf = 0;
  private total = 0;
  private done = 0;
  private current = "";
  private paused = false;

  constructor(
    private onRecord: (r: PreviewRecord) => void,
    private onStatus: (s: GeneratorStatus) => void,
  ) {}

  /** Replace the queue (keeps the job in progress). */
  enqueue(jobs: Job[]) {
    const seen = new Set(this.queue.map((j) => j.key));
    for (const j of jobs) if (!seen.has(j.key)) this.queue.push(j);
    this.total = this.done + this.queue.length + (this.current ? 1 : 0);
    this.status();
    if (!this.running) void this.loop();
  }

  /** Move one preset to the front (the one the user is looking at). */
  prioritize(presetKey: string) {
    const i = this.queue.findIndex((j) => j.presetKey === presetKey);
    if (i > 0) this.queue.unshift(...this.queue.splice(i, 1));
  }

  setPaused(p: boolean) {
    this.paused = p;
  }

  private status() {
    this.onStatus({ done: this.done, total: this.total, current: this.current });
  }

  /** Resolves on the next animation frame. */
  /** Yields to the main picture: the next animation frame, or 16 ms,
   *  whichever is first — a window that is visible but covered gets rAF
   *  only about once a second, which would stall the queue for minutes. */
  private tick(): Promise<void> {
    return new Promise((res) => {
      let done = false;
      const go = () => {
        if (done) return;
        done = true;
        cancelAnimationFrame(this.raf);
        window.clearTimeout(timer);
        res();
      };
      const timer = window.setTimeout(go, 16);
      this.raf = requestAnimationFrame(go);
    });
  }

  private async loop() {
    this.running = true;
    const canvas = document.createElement("canvas");
    canvas.width = FRAME_W;
    canvas.height = FRAME_H;
    this.engine = new MilkdropEngine(canvas);
    try {
      while (this.running && this.queue.length) {
        while (this.paused || document.hidden) {
          await this.tick();
          if (!this.running) return;
        }
        const job = this.queue.shift()!;
        this.current = job.presetKey;
        this.status();
        try {
          const rec = await this.renderJob(job);
          if (rec) {
            await savePreview(rec).catch(() => {});
            this.onRecord(rec);
          }
        } catch (e) {
          console.warn("[previews] failed", job.presetKey, e);
        }
        this.done++;
        this.current = "";
        this.status();
      }
    } finally {
      this.engine?.destroy();
      this.engine = null;
      this.running = false;
    }
  }

  stop() {
    this.running = false;
    this.queue = [];
    cancelAnimationFrame(this.raf);
  }

  private async renderJob(job: Job): Promise<PreviewRecord | null> {
    const eng = this.engine!;
    if (!(await eng.load(job.presetKey, job.preset, 0))) return null;
    const baseVals = ((job.preset as { baseVals?: Record<string, unknown> }).baseVals ?? {});
    const seed = Number.parseInt(job.key.split("|")[1] ?? "1", 36) || 1;
    const variants = [scatter(baseVals, seed), scatter(baseVals, seed * 7 + 3)];

    const sheet = document.createElement("canvas");
    sheet.width = FRAME_W * CLIP_FRAMES;
    sheet.height = FRAME_H;
    const sctx = sheet.getContext("2d")!;

    // motion probe: tiny grayscale copies of consecutive frames
    const probe = document.createElement("canvas");
    probe.width = 32;
    probe.height = 18;
    const pctx = probe.getContext("2d", { willReadFrequently: true })!;
    let prev: Uint8ClampedArray | null = null;
    let motion = 0;
    let bright = 0;
    let samples = 0;

    const bytes = new Uint8Array(1024);
    let t = 0;
    let sliceStart = performance.now();
    for (const phase of SCRIPT) {
      if (phase.variant !== undefined) {
        const p = job.preset as { baseVals?: Record<string, unknown> };
        await eng.load(job.presetKey, { ...p, baseVals: { ...baseVals, ...variants[phase.variant] } }, 0);
      }
      const steps = Math.round(phase.seconds / STEP);
      const captures = new Map<number, number>();
      for (const [at, idx] of phase.captures ?? []) {
        captures.set(Math.min(steps - 1, Math.round(at / STEP)), idx);
      }
      for (let i = 0; i < steps; i++) {
        synth(bytes, t, phase.level, phase.kick ?? 1);
        t += STEP;
        eng.render(bytes, STEP);
        const idx = captures.get(i);
        if (idx !== undefined) sctx.drawImage(eng.canvas, idx * FRAME_W, 0, FRAME_W, FRAME_H);
        if (phase.measure && i % 3 === 0) {
          pctx.drawImage(eng.canvas, 0, 0, 32, 18);
          const px = pctx.getImageData(0, 0, 32, 18).data;
          let d = 0;
          let b = 0;
          for (let k = 0; k < px.length; k += 4) {
            const g = px[k] * 0.3 + px[k + 1] * 0.59 + px[k + 2] * 0.11;
            b += g;
            if (prev) d += Math.abs(g - (prev[k] * 0.3 + prev[k + 1] * 0.59 + prev[k + 2] * 0.11));
          }
          if (prev) {
            motion += d / (32 * 18 * 255);
            samples++;
          }
          bright += b / (32 * 18 * 255);
          prev = px;
        }
        if (performance.now() - sliceStart > BUDGET_MS) {
          await this.tick();
          sliceStart = performance.now();
          if (!this.running) return null;
          while (this.paused || document.hidden) {
            await this.tick();
            if (!this.running) return null;
          }
          if (eng.key !== job.presetKey) return null;
        }
      }
    }

    const still = document.createElement("canvas");
    still.width = FRAME_W;
    still.height = FRAME_H;
    still.getContext("2d")!.drawImage(sheet, 4 * FRAME_W, 0, FRAME_W, FRAME_H, 0, 0, FRAME_W, FRAME_H);
    const [stillBlob, sheetBlob] = await Promise.all([toBlob(still), toBlob(sheet)]);
    if (!stillBlob || !sheetBlob) return null;
    return {
      key: job.key,
      presetKey: job.presetKey,
      still: stillBlob,
      sheet: sheetBlob,
      variants,
      motion: samples ? motion / samples : 0,
      brightness: bright / Math.max(1, samples + 1),
      createdAt: Date.now(),
    };
  }
}

function toBlob(c: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((res) => c.toBlob(res, "image/webp", 0.8));
}

/* ----------------------------------------------------------- suggestions */

/**
 * Energy thirds from the measured previews: mostly motion, a little
 * brightness. Relative on purpose — "hoch" means "among the busiest of what
 * you have", which is what the auto-switch needs to choose between.
 */
export function suggestEnergy(
  recs: { presetKey: string; motion: number; brightness: number }[],
): Map<string, "ruhig" | "mittel" | "hoch"> {
  const out = new Map<string, "ruhig" | "mittel" | "hoch">();
  if (recs.length < 6) return out;
  const rank = (vals: number[]) => {
    const sorted = [...vals].sort((a, b) => a - b);
    return (v: number) => sorted.indexOf(v) / Math.max(1, sorted.length - 1);
  };
  const rm = rank(recs.map((r) => r.motion));
  const rb = rank(recs.map((r) => r.brightness));
  for (const r of recs) {
    const score = rm(r.motion) * 0.75 + rb(r.brightness) * 0.25;
    out.set(r.presetKey, score < 1 / 3 ? "ruhig" : score < 2 / 3 ? "mittel" : "hoch");
  }
  return out;
}
