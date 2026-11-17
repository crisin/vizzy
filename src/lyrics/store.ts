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
import { nowPlaying, positionNow, type Track } from "../regie/nowPlaying";
import { params } from "../params";
import { lyricEvents } from "./events";
import { synced } from "./synced";
import { debugLog } from "./debugLog";

const inTauri = "__TAURI_INTERNALS__" in window;

/** Mirrors `lyrics::Config` (flat, camelCase). */
export type LyricsConfig = {
  enabled: boolean;
  url: string;
  language: string;
  model: string;
  /** transcript log in <app_data>/lyrics-log: 0 off, 1 lines, 2 debug */
  log: number;
  /** also keep the 16 kHz audio Whisper heard, one WAV per song */
  logAudio: boolean;
  /** keep what was heard per song, with song times, in <app_data>/lyrics-takes */
  takes: boolean;
  /** send finished takes to Lyrics Helper: 0 never, 1 when it has no synced
   *  lyrics for the song, 2 always */
  takesUpload: number;
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
  log: 0,
  logAudio: false,
  takes: true,
  takesUpload: 0,
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

/** The engine knobs a preset sets — everything else stays as it is. */
export type Tuning = Pick<
  LyricsConfig,
  | "stepMs"
  | "minWindow"
  | "maxWindow"
  | "edge"
  | "similarity"
  | "silenceDb"
  | "silenceSecs"
  | "minAvgLogprob"
  | "maxReps"
  | "filterInventions"
  | "dropUnconfirmed"
>;

const BALANCED: Tuning = {
  stepMs: DEFAULT_CONFIG.stepMs,
  minWindow: DEFAULT_CONFIG.minWindow,
  maxWindow: DEFAULT_CONFIG.maxWindow,
  edge: DEFAULT_CONFIG.edge,
  similarity: DEFAULT_CONFIG.similarity,
  silenceDb: DEFAULT_CONFIG.silenceDb,
  silenceSecs: DEFAULT_CONFIG.silenceSecs,
  minAvgLogprob: DEFAULT_CONFIG.minAvgLogprob,
  maxReps: DEFAULT_CONFIG.maxReps,
  filterInventions: DEFAULT_CONFIG.filterInventions,
  dropUnconfirmed: DEFAULT_CONFIG.dropUnconfirmed,
};

/** Engine profiles, measured offline on five songs (docs/learnings.md). */
export const PRESETS: { id: string; label: string; does: string; tuning: Tuning }[] = [
  {
    id: "fast",
    label: "Schnell",
    does: "Ø 1,6 s hinter der Musik — erfindet bei schweren Wörtern und Instrumentals eher mal was",
    tuning: { ...BALANCED, stepMs: 300, minWindow: 1.2, maxWindow: 8, edge: 0.5, silenceSecs: 1 },
  },
  {
    id: "balanced",
    label: "Ausgeglichen",
    does: "Ø 2,4 s hinter der Musik — der Standard",
    tuning: BALANCED,
  },
  {
    id: "accurate",
    label: "Akkurat",
    does: "Ø 2,7 s hinter der Musik — mehr Kontext pro Lauf, die wenigsten Fehler",
    tuning: { ...BALANCED, stepMs: 700, minWindow: 2.5, maxWindow: 15, edge: 1, silenceSecs: 2 },
  },
];

/** The preset these knobs match exactly, if any. */
export function presetOf(cfg: LyricsConfig): string | null {
  const keys = Object.keys(BALANCED) as (keyof Tuning)[];
  return PRESETS.find((p) => keys.every((k) => p.tuning[k] === cfg[k]))?.id ?? null;
}

/** One `lyrics` event (`lyrics::Update`). */
type Update = {
  lines: string[];
  /** per line: the song had it before (chorus) */
  repeats?: boolean[];
  committed: number;
  tentative: string;
  behindS: number | null;
  /** how long ago the newest line started (synced lyrics set their clock by it) */
  startedAgoS?: number | null;
  inferMs: number;
  windowS: number;
  error: string | null;
};

export type LyricLine = {
  /** running number since the worker started — stable React key */
  n: number;
  text: string;
  /** the song had this line before — part of a chorus */
  repeat: boolean;
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
    nowPlaying.onSongChange((t) => {
      lyricEvents.reset();
      if (params.get("lyrics", "resetOnSong") >= 0.5) this.reset();
      this.tellSong(t, true);
    });
    // …and whatever else changes: a Spotify id arrives, a seek, a pause
    nowPlaying.subscribe(() => this.tellSong(nowPlaying.getSnapshot().track, false));
    this.tellSong(nowPlaying.getSnapshot().track, true);
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
    const debug = this.snap.cfg.enabled && this.snap.cfg.log >= 2;
    if (debug !== debugLog.on) {
      debugLog.on = debug;
      // the worker must know first, or it drops the note (saving is debounced)
      if (debug) window.setTimeout(() => synced.logNow(), 1000);
    }
    for (const fn of this.listeners) fn();
  }

  private ingest(u: Update) {
    const now = performance.now();
    // the update carries the last few lines, ending with number `committed`
    const first = u.committed - u.lines.length + 1;
    const known = new Map(this.snap.lines.map((l) => [l.n, l]));
    const lines = u.lines.map(
      (text, i) => known.get(first + i) ?? { n: first + i, text, at: now, repeat: u.repeats?.[i] ?? false },
    );
    const added = lines.filter((l) => !known.has(l.n));
    const fresh = added.length > 0;
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
    // synced lyrics tell the events themselves, on time; Whisper is their clock
    if (!synced.active()) for (const l of added) lyricEvents.line(l.text, l.repeat);
    const last = added[added.length - 1];
    if (last) synced.heard(last.text, u.startedAgoS ?? null);
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
    this.configure({ ...BALANCED, prompt: "" });
  }

  applyPreset(id: string) {
    const p = PRESETS.find((x) => x.id === id);
    if (p) this.configure(p.tuning);
  }

  /** what the worker was last told, to tell it again only when it changed */
  private told = { key: "", id: null as string | null, dur: null as number | null, pos: null as number | null, at: 0, playing: false };

  /** The song and where it is: labels the transcript log and times the
   *  lines of a take (the worker has no now playing of its own — the
   *  frontend merges media session and Spotify). `restart`: a song change. */
  private tellSong(t: Track | null, restart: boolean) {
    if (!inTauri) return;
    const on = t && t.status !== "other" && t.title ? t : null;
    const pos = on ? positionNow(on) : null;
    const playing = on?.status === "playing";
    const now = Date.now();
    const o = this.told;
    if (!restart) {
      // the position we told keeps running; only a jump is news (the
      // media session's own samples jitter by a second)
      const expected = o.pos === null ? null : o.pos + (o.playing ? now - o.at : 0);
      const jumped = (pos === null) !== (expected === null) || (pos !== null && expected !== null && Math.abs(pos - expected) > 1500);
      const same =
        (on?.baseKey ?? "") === o.key &&
        (on?.spotifyId ?? null) === o.id &&
        (on?.durationMs ?? null) === o.dur &&
        playing === o.playing &&
        !jumped;
      if (same) return;
    }
    this.told = { key: on?.baseKey ?? "", id: on?.spotifyId ?? null, dur: on?.durationMs ?? null, pos, at: now, playing };
    const song = on && {
      artist: on.artist,
      title: on.title,
      spotifyId: on.spotifyId,
      durationMs: on.durationMs === null ? null : Math.round(on.durationMs),
    };
    void invoke("lyrics_song", { song, restart, positionMs: pos, playing }).catch(() => {});
  }

  /** Everything for debugging in one switch: every Whisper run, the synced
   *  lyrics' decisions and the audio. Off goes back to no log at all. */
  recordAll(on: boolean) {
    this.configure(on ? { log: 2, logAudio: true } : { log: 0, logAudio: false });
  }

  openLog() {
    if (inTauri) void invoke("data_open_dir", { dir: "lyrics-log" }).catch((e) => this.set({ error: String(e) }));
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
    let reps = this.snap.lines.map((l) => l.repeat);
    this.demoTimer = window.setInterval(() => {
      const { w, end } = words[i % words.length];
      i++;
      line.push(w);
      if (end) {
        n++;
        all = [...all, line.join(" ")].slice(-12);
        reps = [...reps, i > words.length].slice(-12);
        line = [];
      }
      const behindS = end ? 1.6 + Math.random() * 1.2 : null;
      this.ingest({
        lines: all,
        repeats: reps,
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
