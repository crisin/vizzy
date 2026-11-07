// Live audio state shared between the render loop and everything else that
// wants to react to the music without owning the loop: the library's live
// tile, the tag-driven auto-switch, the debug HUD.
//
// The render loop writes here once per frame; readers only read. Plain
// mutable module state on purpose — this runs at 60–120 Hz and must not
// touch React.

/** Butterchurn's input: 1024 unsigned bytes, 128 = silence. Already scaled
 *  by the sensitivity gain, so every instance sees what the main one sees. */
export const liveTimeByte = new Uint8Array(1024).fill(128);

export const ENERGY_LEVELS = ["ruhig", "mittel", "hoch"] as const;
export type EnergyLevel = 0 | 1 | 2;

/** Detected musical moment at a section boundary. */
export type SectionMove = "up" | "down" | "flat";

class LiveState {
  rms = 0;
  /** ~2 s smoothing — "right now" */
  short = 0;
  /** ~8 s smoothing — the level the plan talks about */
  long = 0;
  /** adaptive window over `long`, see `update` */
  private lo = 0.02;
  private hi = 0.2;
  /** 0..1 position of `long` inside the adaptive window */
  norm = 0.5;
  level: EnergyLevel = 1;
  /** performance.now() when the current track started: a song change from
   *  the media session (`regie/nowPlaying.ts`), or — without metadata —
   *  sound coming back after silence */
  trackStartAt = 0;
  /** true while the media session reports a playing track; the silence
   *  heuristic then stays quiet so a gap inside a song isn't a "new track" */
  metaActive = false;
  private silentFor = 0;
  /** last section boundary and which way the energy went there */
  lastSectionAt = -1e9;
  lastMove: SectionMove = "flat";
  private prevSection = 0;
  phrasePhase = 0;
  gridConf = 0;
  /** last auto-switch choice, for the debug HUD */
  lastPick = "";
  /** current tempo estimate (0 = unknown) */
  bpm = 0;

  /** Seconds per bar at the current tempo, 2 s when the tempo is unknown. */
  barSeconds(): number {
    return this.bpm > 40 ? (4 * 60) / this.bpm : 2;
  }

  update(rms: number, section: number, phrasePhase: number, gridConf: number, dt: number) {
    this.rms = rms;
    this.phrasePhase = phrasePhase;
    this.gridConf = gridConf;
    const now = performance.now();
    const a2 = 1 - Math.exp(-dt / 2);
    const a8 = 1 - Math.exp(-dt / 8);
    this.short += (rms - this.short) * a2;
    this.long += (rms - this.long) * a8;

    // Same idea as AutoRange in morph.ts: the window brackets what this
    // track is doing, so a quiet album is not "ruhig" for its whole length.
    // Floor follows down fast and creeps up; ceiling the mirror image.
    const creep = 1 - Math.exp(-dt / 90);
    if (this.long < this.lo) this.lo = this.long;
    else this.lo += (this.long - this.lo) * creep;
    if (this.long > this.hi) this.hi = this.long;
    else this.hi += (this.long - this.hi) * creep;
    const span = Math.max(1e-3, this.hi - this.lo);
    this.norm = Math.min(1, Math.max(0, (this.long - this.lo) / span));
    // hysteresis so the level doesn't chatter on a boundary
    const n = this.norm;
    if (this.level === 0 && n > 0.4) this.level = 1;
    else if (this.level === 2 && n < 0.6) this.level = 1;
    else if (this.level === 1) {
      if (n < 0.3) this.level = 0;
      else if (n > 0.7) this.level = 2;
    }

    // silence → sound counts as a new track (for the "intro" tag)
    if (rms < 0.005) this.silentFor += dt;
    else {
      if (this.silentFor > 2.5 && !this.metaActive) this.trackStartAt = now;
      this.silentFor = 0;
    }

    if (section >= 0.7 && this.prevSection < 0.7) {
      this.lastSectionAt = now;
      const r = this.short / Math.max(1e-4, this.long);
      this.lastMove = r > 1.15 ? "up" : r < 0.85 ? "down" : "flat";
    }
    this.prevSection = section;
  }

  /** A song change reported by the media session. */
  markTrackStart() {
    this.trackStartAt = performance.now();
  }

  /** Seconds since the current track started. */
  trackAge(): number {
    return (performance.now() - this.trackStartAt) / 1000;
  }

  /** Seconds since the last section boundary. */
  sinceSection(): number {
    return (performance.now() - this.lastSectionAt) / 1000;
  }
}

export const live = new LiveState();
