// Live lyrics, frontend side: what the Rust worker (`src-tauri/src/lyrics.rs`)
// reports through the `lyrics` event, plus its config in lyrics.json.
//
// The webview never talks to the Whisper server itself (local servers send
// no CORS headers); it only reads events and calls the lyrics_* commands.
// In the browser preview (`npm run dev`) a small demo stream stands in, so
// the overlay and its settings can be tried without the app.

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { nowPlaying } from "../regie/nowPlaying";
import { params } from "../params";

const inTauri = "__TAURI_INTERNALS__" in window;

/** Mirrors `lyrics::Config` (flat, camelCase). */
export type LyricsConfig = {
  enabled: boolean;
  url: string;
  language: string;
  model: string;
  stepMs: number;
  minWindow: number;
  maxWindow: number;
  edge: number;
  similarity: number;
  silenceDb: number;
  silenceSecs: number;
  minAvgLogprob: number;
  maxReps: number;
  filterInventions: boolean;
  dropUnconfirmed: boolean;
  prompt: string;
};

export const DEFAULT_CONFIG: LyricsConfig = {
  enabled: false,
  url: "http://127.0.0.1:8178",
  language: "auto",
  model: "",
  stepMs: 500,
  minWindow: 1.5,
  maxWindow: 12,
  edge: 0.7,
  similarity: 0.8,
  silenceDb: -48,
  silenceSecs: 1.5,
  minAvgLogprob: -1.2,
  maxReps: 4,
  filterInventions: true,
  dropUnconfirmed: true,
  prompt: "",
};

/** One `lyrics` event (`lyrics::Update`). */
type Update = {
  lines: string[];
  committed: number;
  tentative: string;
  behindS: number | null;
  inferMs: number;
  windowS: number;
  error: string | null;
};

export type LyricLine = {
  /** running number since the worker started — stable React key */
  n: number;
  text: string;
  /** performance.now() when it arrived */
  at: number;
};

export type LyricsSnapshot = {
  cfg: LyricsConfig;
  /** config read from the app (false until then, and in the browser demo) */
  loaded: boolean;
  lines: LyricLine[];
  tentative: string;
  /** performance.now() of the last event that brought text */
  lastTextAt: number;
  error: string | null;
  /** last measured values, for the stats line and the settings */
  behindS: number | null;
  inferMs: number;
  windowS: number;
  /** a few recent "behind" values, to show an average */
  behindAvg: number | null;
  /** performance.now() of the last event at all — tells "running" from "silent" */
  lastEventAt: number;
  demo: boolean;
};

class LyricsStore {
  private snap: LyricsSnapshot = {
    cfg: DEFAULT_CONFIG,
    loaded: false,
    lines: [],
    tentative: "",
    lastTextAt: 0,
    error: null,
    behindS: null,
    inferMs: 0,
    windowS: 0,
    behindAvg: null,
    lastEventAt: 0,
    demo: !inTauri,
  };
  private listeners = new Set<() => void>();
  private behind: number[] = [];
  private saveTimer: number | undefined;
  private demoTimer: number | undefined;

  constructor() {
    if (inTauri) {
      void listen<Update>("lyrics", (e) => this.ingest(e.payload));
      void invoke<LyricsConfig>("lyrics_config")
        .then((cfg) => this.set({ cfg: { ...DEFAULT_CONFIG, ...cfg }, loaded: true }))
        .catch(() => {});
    }
    // a new song: start from a clean window, so the old song's tail does
    // not end up as the new song's first line
    nowPlaying.onSongChange(() => {
      if (params.get("lyrics", "resetOnSong") >= 0.5) this.reset();
    });
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = () => this.snap;

  private set(patch: Partial<LyricsSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn();
  }

  private ingest(u: Update) {
    const now = performance.now();
    // the update carries the last few lines, ending with number `committed`
    const first = u.committed - u.lines.length + 1;
    const known = new Map(this.snap.lines.map((l) => [l.n, l]));
    const lines = u.lines.map((text, i) => known.get(first + i) ?? { n: first + i, text, at: now });
    const fresh = lines.some((l) => !known.has(l.n));
    if (u.behindS != null) {
      this.behind.push(u.behindS);
      if (this.behind.length > 12) this.behind.shift();
    }
    const brought = fresh || (u.tentative !== "" && u.tentative !== this.snap.tentative);
    this.set({
      lines,
      tentative: u.tentative,
      lastTextAt: brought ? now : this.snap.lastTextAt,
      error: u.error,
      behindS: u.behindS ?? this.snap.behindS,
      inferMs: u.inferMs || this.snap.inferMs,
      windowS: u.windowS,
      behindAvg: this.behind.length ? this.behind.reduce((a, b) => a + b, 0) / this.behind.length : null,
      lastEventAt: now,
    });
  }

  /** Changes the config; the worker picks it up on its next step. Saving to
   *  lyrics.json is debounced, so dragging a slider does not write 60 files. */
  configure(patch: Partial<LyricsConfig>) {
    const cfg = { ...this.snap.cfg, ...patch };
    this.set({ cfg });
    if (patch.enabled === false) this.set({ lines: [], tentative: "", error: null });
    if (this.snap.demo) {
      this.runDemo();
      return;
    }
    window.clearTimeout(this.saveTimer);
    const now = "enabled" in patch; // the on/off switch must not lag
    this.saveTimer = window.setTimeout(
      () => {
        void invoke<LyricsConfig>("lyrics_configure", { cfg: this.snap.cfg })
          .then((saved) => {
            // the worker clamps hand-made values; show what it really uses
            if (JSON.stringify(saved) !== JSON.stringify(this.snap.cfg)) this.set({ cfg: { ...this.snap.cfg, ...saved } });
          })
          .catch((e) => this.set({ error: `Speichern fehlgeschlagen: ${e}` }));
      },
      now ? 0 : 300,
    );
  }

  resetTuning() {
    const { enabled, url, language, model } = this.snap.cfg;
    this.configure({ ...DEFAULT_CONFIG, enabled, url, language, model });
  }

  /** Forgets window and lines (worker side too). */
  reset() {
    this.behind = [];
    this.set({ lines: [], tentative: "", behindS: null, behindAvg: null, lastTextAt: 0 });
    if (inTauri) void invoke("lyrics_reset").catch(() => {});
  }

  /** Round trip to the server with a second of silence: milliseconds. */
  async test(url: string): Promise<number> {
    if (!inTauri) throw new Error("Nur in der App — im Browser läuft eine Demo");
    return invoke<number>("lyrics_test", { url });
  }

  // ------------------------------------------------------------- demo
  // Browser preview only: invented lines (no real song text), fed the way
  // the worker would — tentative first, committed a moment later.

  private runDemo() {
    window.clearInterval(this.demoTimer);
    if (!this.snap.cfg.enabled) return;
    const words = DEMO.flatMap((l) => l.split(" ").map((w, i, a) => ({ w, end: i === a.length - 1 })));
    let i = 0;
    let line: string[] = [];
    let n = this.snap.lines[this.snap.lines.length - 1]?.n ?? 0;
    let all = this.snap.lines.map((l) => l.text);
    this.demoTimer = window.setInterval(() => {
      const { w, end } = words[i % words.length];
      i++;
      line.push(w);
      if (end) {
        n++;
        all = [...all, line.join(" ")].slice(-12);
        line = [];
      }
      const behindS = end ? 1.6 + Math.random() * 1.2 : null;
      this.ingest({
        lines: all,
        committed: n,
        tentative: line.join(" "),
        behindS,
        inferMs: 180 + Math.round(Math.random() * 60),
        windowS: 2 + line.length * 0.4,
        error: null,
      });
    }, this.snap.cfg.stepMs);
  }

  startDemo() {
    if (this.snap.demo && this.snap.cfg.enabled) this.runDemo();
  }
}

const DEMO = [
  "Neonlicht über leeren Straßen",
  "wir zählen Takte bis zum Morgen",
  "jede Welle bricht ein bisschen später",
  "und das Echo bleibt noch lange wach",
  "Hold the line until the colours fade",
  "spin the lights around the room again",
];

export const lyrics = new LyricsStore();

export function useLyrics(): LyricsSnapshot {
  return useSyncExternalStore(lyrics.subscribe, lyrics.getSnapshot);
}
