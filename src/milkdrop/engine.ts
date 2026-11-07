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

// Console capture shared by all engines: installed while at least one load
// is in flight, every active load gets its own list.
const sinks = new Set<string[]>();
let origError: typeof console.error | null = null;
let origWarn: typeof console.warn | null = null;

function startCapture(): string[] {
  const sink: string[] = [];
  if (sinks.size === 0) {
    origError = console.error;
    origWarn = console.warn;
    const wrap =
      (orig: (...a: unknown[]) => void) =>
      (...args: unknown[]) => {
        const msg = args.map(String).join(" ");
        for (const s of sinks) s.push(msg);
        orig.apply(console, args);
      };
    console.error = wrap(origError);
    console.warn = wrap(origWarn);
  }
  sinks.add(sink);
  return sink;
}

function stopCapture(sink: string[]) {
  sinks.delete(sink);
  if (sinks.size === 0 && origError && origWarn) {
    console.error = origError;
    console.warn = origWarn;
  }
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
  private shaderErrors: string[] = [];

  /**
   * Butterchurn never checks whether a preset's shaders compiled — a broken
   * warp or comp shader just renders nothing. Wrapping compileShader on this
   * engine's own context is the one place the driver's message is still
   * available.
   */
  private watchShaders() {
    // Butterchurn renders on an internal (offscreen) WebGL2 canvas and
    // copies the result into ours with a 2D context.
    const gl = (this.viz as unknown as { gl?: WebGL2RenderingContext }).gl;
    if (!gl || typeof gl.compileShader !== "function") return;
    const orig = gl.compileShader.bind(gl);
    gl.compileShader = (shader: WebGLShader) => {
      orig(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = (gl.getShaderInfoLog(shader) ?? "").replace(/\u0000/g, "").trim();
        if (log) this.shaderErrors.push(`Shader: ${log}`);
      }
    };
  }

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
      this.watchShaders();
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
    // Butterchurn reports shader compile errors on the console instead of
    // throwing; catch them for the duration of the load so an editor can
    // show what went wrong.
    const seen = startCapture();
    this.shaderErrors = [];
    try {
      await Promise.resolve(this.viz.loadPreset(preset as object, blend));
      if (seq === this.loadSeq) this.held = false;
      this.error = [
        ...this.shaderErrors,
        ...seen.filter((m) => /error|fail|compile|shader/i.test(m)),
      ].join("\n");
      return true;
    } catch (e) {
      this.error = [String(e), ...seen].join("\n");
      return false;
    } finally {
      stopCapture(seen);
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
