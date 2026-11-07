// A self-contained Butterchurn instance for everything that is *not* the main
// picture: the library's live tile and the preview generator. Each owns its
// own canvas and WebGL context; they share one AudioContext (Butterchurn
// wants one, but we feed it bytes directly and never connect a node).
//
// The main render path in App.tsx still has its own copy of this logic with
// the auto-switch and phrase dynamics woven in; it moves over here once the
// layering work needs two main instances.

import type { BCVisualizer } from "butterchurn";

let sharedCtx: AudioContext | null = null;
let bcModule: Promise<typeof import("butterchurn")["default"]> | null = null;

function butterchurn() {
  bcModule ??= import("butterchurn").then((m) => m.default);
  return bcModule;
}

export class MilkdropEngine {
  readonly canvas: HTMLCanvasElement;
  private viz: BCVisualizer | null = null;
  private loading: Promise<void> | null = null;
  private loadedKey = "";
  private loadSeq = 0;
  private held = false;
  private traps = 0;
  private lastPreset: unknown = null;
  /** last error (compile or render), for the caller to show */
  error = "";

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  async init(): Promise<boolean> {
    if (this.viz) return true;
    this.loading ??= butterchurn().then((bc) => {
      sharedCtx ??= new AudioContext();
      this.viz = bc.createVisualizer(sharedCtx, this.canvas, {
        width: this.canvas.width,
        height: this.canvas.height,
      });
    });
    try {
      await this.loading;
      return true;
    } catch (e) {
      this.error = String(e);
      return false;
    }
  }

  get ready(): boolean {
    return this.viz != null;
  }

  get key(): string {
    return this.loadedKey;
  }

  setSize(w: number, h: number) {
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.viz?.setRendererSize(w, h);
  }

  /** Resolves once the preset's equations are compiled and it renders. */
  async load(key: string, preset: unknown, blend = 0): Promise<boolean> {
    if (!(await this.init()) || !this.viz) return false;
    const seq = ++this.loadSeq;
    this.loadedKey = key;
    this.lastPreset = preset;
    this.held = true;
    this.error = "";
    this.traps = 0;
    try {
      await Promise.resolve(this.viz.loadPreset(preset as object, blend));
      if (seq === this.loadSeq) this.held = false;
      return true;
    } catch (e) {
      this.error = String(e);
      return false;
    }
  }

  /** Renders one frame. Returns false when the preset trapped. */
  render(timeByte: Uint8Array, elapsed: number): boolean {
    if (!this.viz || this.held) return true;
    try {
      this.viz.render({
        audioLevels: {
          timeByteArray: timeByte,
          timeByteArrayL: timeByte,
          timeByteArrayR: timeByte,
        },
        elapsedTime: Math.min(Math.max(elapsed, 0.001), 0.1),
      });
      return true;
    } catch (e) {
      this.error = String(e);
      // same recovery as the main picture: reload to clear bad state
      if (++this.traps <= 2 && this.lastPreset) {
        void this.load(this.loadedKey, this.lastPreset, 0);
      } else {
        this.held = true;
      }
      return false;
    }
  }

  destroy() {
    this.loadSeq++;
    // free the GPU context now rather than whenever GC gets to it
    try {
      this.viz?.loseGLContext();
    } catch {
      // already gone
    }
    this.viz = null;
  }
}
