// Layer B — a second Milkdrop preset rendered on its own canvas on top of the
// main one and mixed by CSS (mix-blend-mode + opacity), so two presets can
// run as one picture.
//
// Each layer can listen to a different part of the spectrum. Butterchurn
// derives bass/mid/treble from the waveform it is given, so the band split
// happens on the waveform itself: a one-pole low-pass keeps the bass, the
// signal minus a low-pass keeps the highs. Crude, but it is exactly the lever
// that changes what a preset reacts to.

import { MilkdropEngine } from "./engine";
import { liveTimeByte } from "./live";

export type LayerBand = 0 | 1 | 2; // alles | bass | höhen

export type LayerBConfig = {
  enabled: boolean;
  key: string;
  blend: string;
  opacity: number;
  gain: number;
  band: LayerBand;
  /** switch B along with A's auto-switch, one bar later */
  auto: boolean;
  /** render scale relative to the main canvas */
  scale: number;
  /** which part of the spectrum the main preset (A) listens to */
  bandA: LayerBand;
};

export const DEFAULT_LAYER_B: LayerBConfig = {
  enabled: false,
  key: "",
  blend: "screen",
  opacity: 0.7,
  gain: 1,
  band: 0,
  auto: true,
  scale: 0.75,
  bandA: 0,
};

export const LAYER_BAND_LABELS = ["Alles", "Nur Bass", "Nur Höhen"];
export const LAYER_BLENDS = ["screen", "lighten", "overlay", "difference", "multiply", "color-dodge", "normal"];

/** Shapes a waveform for one layer: band split and gain. Reads `src`
 *  (default: the shared live waveform); `src === out` works in place. */
export function shapeWave(
  out: Uint8Array,
  band: LayerBand,
  gain: number,
  src: Uint8Array = liveTimeByte,
) {
  const n = Math.min(out.length, src.length);
  // cutoffs as one-pole coefficients at ~44.1 kHz: ~250 Hz and ~2 kHz
  const aLow = 0.035;
  const aHigh = 0.25;
  let lp = 0;
  let lp2 = 0;
  for (let i = 0; i < n; i++) {
    const x = (src[i] - 128) / 127;
    let y = x;
    if (band === 1) {
      lp += (x - lp) * aLow;
      y = lp * 2.2; // low-pass loses level; give some back
    } else if (band === 2) {
      lp2 += (x - lp2) * aHigh;
      y = (x - lp2) * 1.8;
    }
    const v = Math.max(-1, Math.min(1, y * gain));
    out[i] = (v * 127 + 128) | 0;
  }
}

export class LayerB {
  private engine: MilkdropEngine;
  private bytes = new Uint8Array(1024).fill(128);
  private loadedKey = "";
  private loadedVersion = -1;
  private last = performance.now();

  constructor(readonly canvas: HTMLCanvasElement) {
    this.engine = new MilkdropEngine(canvas);
  }

  /** `resolve` turns a preset key into Butterchurn JSON (null while the
   *  preset pack is still loading). `version` bumps when the preset's
   *  content changes (user preset edited). */
  render(cfg: LayerBConfig, resolve: (key: string) => unknown | null, version: number, blend: number) {
    const now = performance.now();
    const dt = (now - this.last) / 1000;
    this.last = now;
    if (!cfg.enabled || !cfg.key) return;

    const w = Math.max(16, Math.round(this.canvas.clientWidth * cfg.scale));
    const h = Math.max(16, Math.round(this.canvas.clientHeight * cfg.scale));
    if (this.canvas.clientWidth > 0) this.engine.setSize(w, h);

    if (cfg.key !== this.loadedKey || version !== this.loadedVersion) {
      const preset = resolve(cfg.key);
      if (!preset) return;
      const first = this.loadedKey === "";
      this.loadedKey = cfg.key;
      this.loadedVersion = version;
      void this.engine.load(cfg.key, preset, first ? 0 : blend);
    }
    shapeWave(this.bytes, cfg.band, cfg.gain);
    this.engine.render(this.bytes, dt);
  }

  get error(): string {
    return this.engine.error;
  }
}
