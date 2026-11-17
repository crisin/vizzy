// Synced lyrics (PLAN-stimme.md, S3): when Lyrics Helper knows the song and
// has timed lines, the overlay shows those — on time, with the next line as
// a preview — instead of what Whisper heard a few seconds ago. Whisper keeps
// running as the clock: every line it hears is located in the synced text,
// which corrects a media position that is off (SMTC is coarse), follows a
// seek, and gives a clock where there is no position at all.
//
// The pure parts (matching, clock) are in syncCore.ts.

import { useSyncExternalStore } from "react";
import { nowPlaying, positionNow, type Track } from "../regie/nowPlaying";
import { newHelper } from "../regie/newHelper";
import { params } from "../params";
import { SyncClock, lineAt, locate, similarity, words, type TimedLine } from "./syncCore";
import { lyricEvents } from "./events";
import { debugLog } from "./debugLog";

/** a running clock without media position dies after this long without a match */
const ANCHOR_TTL_MS = 45_000;
/** search window around the expected song time */
const SEARCH_MS = 25_000;
const CHORUS = /chorus|refrain|hook|kehrvers/i;

export type SyncSnapshot = {
  /** Lyrics Helper has timed lines for the playing song */
  available: boolean;
  /** …and a clock to show them by */
  usable: boolean;
  lines: TimedLine[];
  /** per line: chorus (repeated text or a chorus section) */
  repeats: boolean[];
  index: number;
  /** performance.now() when `index` became current */
  indexAt: number;
  offsetMs: number;
  matched: number;
  clock: "media" | "whisper" | "none";
  song: string | null;
};

const EMPTY: SyncSnapshot = {
  available: false,
  usable: false,
  lines: [],
  repeats: [],
  index: -1,
  indexAt: 0,
  offsetMs: 0,
  matched: 0,
  clock: "none",
  song: null,
};

class SyncedLyrics {
  private snap: SyncSnapshot = EMPTY;
  private listeners = new Set<() => void>();
  private clock = new SyncClock();
  private songKey: string | null = null;

  constructor() {
    const follow = () => this.follow(nowPlaying.getSnapshot().track);
    nowPlaying.subscribe(follow);
    newHelper.subscribe(follow);
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = () => this.snap;

  private set(patch: Partial<SyncSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn();
  }

  /** "auto" uses synced lines whenever they work; "whisper" never; "synced" only */
  mode(): "auto" | "whisper" | "synced" {
    return (["auto", "whisper", "synced"] as const)[params.get("lyrics", "source") | 0] ?? "auto";
  }

  /** the overlay shows synced lines right now */
  active(): boolean {
    return this.mode() !== "whisper" && this.snap.usable;
  }

  /** New song or new info from Lyrics Helper: take its timed lines. */
  private follow(t: Track | null) {
    const key = t && t.status !== "other" ? t.baseKey : null;
    const info = t ? newHelper.infoFor(t) : undefined;
    const raw = info?.found ? (info.lines ?? []) : [];
    const lines = raw
      .filter((l): l is TimedLine => l.startMs !== null && l.text.trim() !== "")
      .sort((a, b) => a.startMs - b.startMs);
    if (key === this.songKey && lines.length === this.snap.lines.length) return;
    if (key !== this.songKey) {
      this.clock.reset();
      this.songKey = key;
    }
    const sections = (info?.sections ?? []).filter((s) => s.startMs !== null) as { label: string; startMs: number }[];
    this.logHelper(t, info?.found ?? null, raw.length, lines, sections);
    this.set({
      available: lines.length >= 3,
      lines,
      repeats: chorusFlags(lines, sections),
      index: -1,
      song: t ? `${t.artist} – ${t.title}` : null,
    });
  }

  /** Debug log: what Lyrics Helper has for the song (the whole timed text). */
  private logHelper(
    t: Track | null,
    found: boolean | null,
    untimed: number,
    lines: TimedLine[],
    sections: { label: string; startMs: number }[],
  ) {
    if (!t || !debugLog.on) return;
    this.helperLogged = `${this.songKey}|${found}|${untimed}|${lines.length}`;
    debugLog.note("helper", {
      // null: not asked or no answer yet
      found,
      linesTotal: untimed,
      lines: lines.map((l) => ({ startMs: l.startMs, text: l.text })),
      sections,
    });
  }
  private helperLogged = "";

  /** The debug log went on mid-song: note the text in play once more. */
  logNow() {
    const s = this.snap;
    const t = nowPlaying.getSnapshot().track;
    if (!t || !s.song || this.helperLogged.startsWith(`${this.songKey}|`)) return;
    this.logHelper(t, s.lines.length > 0 ? true : null, s.lines.length, s.lines, []);
  }

  /** From the lyrics store: Whisper committed `text`, which started `agoS` ago. */
  heard(text: string, agoS: number | null) {
    if (!this.snap.available || agoS === null) return;
    const now = performance.now();
    const pos = positionNow(nowPlaying.getSnapshot().track);
    const expected = this.clock.songMs(pos, now);
    const hit =
      locate(this.snap.lines, text, expected === null ? null : expected - agoS * 1000, SEARCH_MS) ??
      // no clock yet, or lost: the whole song, but only a strong match
      (expected === null || this.clock.matched === 0 ? locate(this.snap.lines, text, null, 0, 0.75) : null);
    const about = {
      heard: text,
      agoMs: Math.round(agoS * 1000),
      positionMs: pos === null ? null : Math.round(pos),
      expectedMs: expected === null ? null : Math.round(expected - agoS * 1000),
    };
    if (!hit) {
      debugLog.note("match", { ...about, hit: null });
      return;
    }
    const before = this.clock.offsetMs;
    this.clock.match(this.snap.lines[hit.index].startMs, agoS * 1000, pos, now);
    debugLog.note("match", {
      ...about,
      hit: {
        index: hit.index,
        sim: Math.round(hit.sim * 100) / 100,
        startMs: this.snap.lines[hit.index].startMs,
        text: this.snap.lines[hit.index].text,
      },
      offsetBeforeMs: Math.round(before),
      offsetMs: Math.round(this.clock.offsetMs),
      matched: this.clock.matched,
    });
    this.set({ offsetMs: this.clock.offsetMs, matched: this.clock.matched });
  }

  /** Every frame from the render loop: which line is due. */
  tick() {
    const s = this.snap;
    if (!s.available) {
      if (s.usable) this.set({ usable: false, clock: "none" });
      return;
    }
    const now = performance.now();
    const pos = positionNow(nowPlaying.getSnapshot().track);
    if (pos === null && now - this.clock.lastMatchReal > ANCHOR_TTL_MS) this.clock.anchorSong = null;
    const songMs = this.clock.songMs(pos, now);
    const clock = pos !== null ? "media" : songMs !== null ? "whisper" : "none";
    const usable = songMs !== null;
    const index = songMs === null ? -1 : lineAt(s.lines, songMs);
    if (index !== s.index || usable !== s.usable || clock !== s.clock) {
      this.set({ index, indexAt: now, usable, clock });
      debugLog.note("show", {
        index,
        text: index >= 0 ? s.lines[index].text : null,
        startMs: index >= 0 ? s.lines[index].startMs : null,
        songMs: songMs === null ? null : Math.round(songMs),
        positionMs: pos === null ? null : Math.round(pos),
        clock,
        // false: Whisper's lines are on screen (source "whisper")
        onScreen: this.active(),
      });
      if (index > s.index && index >= 0 && this.active()) {
        lyricEvents.line(s.lines[index].text, s.repeats[index] ?? false);
      }
    }
  }
}

/** Chorus lines: text the song had before (≥ 3 words), or inside a section
 *  labelled chorus / refrain / hook. */
function chorusFlags(lines: TimedLine[], sections: { label: string; startMs: number }[]): boolean[] {
  const sorted = [...sections].sort((a, b) => a.startMs - b.startMs);
  return lines.map((l, i) => {
    let label = "";
    for (const s of sorted) if (s.startMs <= l.startMs) label = s.label;
    if (CHORUS.test(label)) return true;
    return words(l.text).length >= 3 && lines.slice(0, i).some((p) => similarity(p.text, l.text) >= 0.7);
  });
}

export const synced = new SyncedLyrics();

export function useSynced(): SyncSnapshot {
  return useSyncExternalStore(synced.subscribe, synced.getSnapshot);
}
