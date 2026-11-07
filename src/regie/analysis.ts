// Song analysis, recorded while a song plays: an energy curve (one value
// per second of song time) and where vizzy's section detection fired.
// The choreo editor draws it as the timeline and builds the section list
// from it. Each listen fills gaps and refines it.
//
// <app_data>/analysis/<hash>.json — one file per song (keyed by the
// source-independent baseKey); localStorage in the browser preview.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { live } from "../milkdrop/live";
import type { Track } from "./nowPlaying";

const inTauri = "__TAURI_INTERNALS__" in window;
const LS_PREFIX = "vizzy.analysis.";

export type SongAnalysis = {
  version: 1;
  key: string;
  title: string;
  artist: string;
  durationMs: number;
  /** mean short-term level per second of song time; null = not heard yet */
  energy: (number | null)[];
  /** song positions (ms) of detected section changes */
  sections: number[];
  /** share of seconds the section list was recorded over (0..1) */
  sectionCoverage: number;
  bpm: number;
  updated: number;
};

/** FNV-1a, for a file name that is safe whatever the title contains. */
export function songId(baseKey: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < baseKey.length; i++) {
    h ^= baseKey.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

const cache = new Map<string, SongAnalysis | null>();
const listeners = new Set<(key: string) => void>();

async function readStored(key: string): Promise<SongAnalysis | null> {
  if (cache.has(key)) return cache.get(key) ?? null;
  let a: SongAnalysis | null = null;
  try {
    const s = inTauri
      ? await invoke<string | null>("data_read", { name: `analysis/${songId(key)}.json` })
      : localStorage.getItem(LS_PREFIX + songId(key));
    if (s) a = JSON.parse(s);
  } catch {
    a = null;
  }
  cache.set(key, a);
  return a;
}

function writeStored(a: SongAnalysis) {
  cache.set(a.key, a);
  const json = JSON.stringify(a);
  if (inTauri) void invoke("data_write", { name: `analysis/${songId(a.key)}.json`, contents: json }).catch(() => {});
  else {
    try {
      localStorage.setItem(LS_PREFIX + songId(a.key), json);
    } catch {
      // ignore
    }
  }
  for (const fn of listeners) fn(a.key);
}

/** Recording state for the song that is playing now. */
type Capture = {
  key: string;
  title: string;
  artist: string;
  durationMs: number;
  sum: number[];
  n: number[];
  sections: number[];
  lastSectionAt: number;
  bpms: number[];
  savedAt: number;
};

class Recorder {
  private cap: Capture | null = null;
  private lastTick = 0;

  /** Called from the director's tick (per frame), throttled here. */
  tick(track: Track | null, posMs: number | null) {
    const now = performance.now();
    if (now - this.lastTick < 100) return;
    this.lastTick = now;

    if (!track || this.cap?.key !== track.baseKey) {
      if (this.cap) void this.flush();
      this.cap = track
        ? {
            key: track.baseKey,
            title: track.title,
            artist: track.artist,
            durationMs: track.durationMs ?? 0,
            sum: [],
            n: [],
            sections: [],
            lastSectionAt: live.lastSectionAt,
            bpms: [],
            savedAt: now,
          }
        : null;
      return;
    }
    const c = this.cap;
    if (track.durationMs) c.durationMs = track.durationMs;
    if (track.status !== "playing" || posMs === null) return;

    const sec = Math.floor(posMs / 1000);
    c.sum[sec] = (c.sum[sec] ?? 0) + live.short;
    c.n[sec] = (c.n[sec] ?? 0) + 1;
    if (live.lastSectionAt !== c.lastSectionAt) {
      c.lastSectionAt = live.lastSectionAt;
      c.sections.push(Math.round(posMs));
    }
    if (live.bpm > 40 && live.gridConf >= 0.5) c.bpms.push(live.bpm);
    if (now - c.savedAt > 20_000) void this.flush();
  }

  /** Merge what was heard into the stored analysis. */
  private async flush() {
    const c = this.cap;
    if (!c) return;
    c.savedAt = performance.now();
    const heard = c.n.filter(Boolean).length;
    if (heard < 10 || !c.durationMs) return;
    const old = await readStored(c.key);
    const secs = Math.ceil(c.durationMs / 1000);
    const energy: (number | null)[] = Array.from({ length: secs }, (_, i) =>
      c.n[i] ? c.sum[i] / c.n[i] : (old?.energy[i] ?? null),
    );
    const coverage = heard / secs;
    // sections only make sense from one continuous listen: keep whichever
    // listen covered more of the song
    const useNew = !old || coverage >= old.sectionCoverage;
    const bpms = [...c.bpms].sort((a, b) => a - b);
    const bpm = bpms.length ? bpms[bpms.length >> 1] : (old?.bpm ?? 0);
    writeStored({
      version: 1,
      key: c.key,
      title: c.title,
      artist: c.artist,
      durationMs: c.durationMs,
      energy,
      sections: useNew ? [...c.sections] : old!.sections,
      sectionCoverage: useNew ? Math.min(1, coverage) : old!.sectionCoverage,
      bpm,
      updated: Date.now(),
    });
  }
}

export const analysisRecorder = new Recorder();

/** Stored analysis of one song (null while unknown / not recorded yet). */
export function useAnalysis(baseKey: string | null): SongAnalysis | null {
  const [a, setA] = useState<SongAnalysis | null>(() => (baseKey ? (cache.get(baseKey) ?? null) : null));
  useEffect(() => {
    if (!baseKey) {
      setA(null);
      return;
    }
    let alive = true;
    void readStored(baseKey).then((x) => alive && setA(x));
    const fn = (k: string) => {
      if (k === baseKey) setA(cache.get(k) ?? null);
    };
    listeners.add(fn);
    return () => {
      alive = false;
      listeners.delete(fn);
    };
  }, [baseKey]);
  return a;
}

if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__vizzyAnalysis = analysisRecorder;
}
