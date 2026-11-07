// Learned fit: + / - while a song plays also remember "this picture fits
// (or not) THIS song, THIS artist, THIS playlist". The auto-switch and the
// smart pools weigh candidates by it, and a song that has a clear favourite
// starts with it — the assignment learns itself, no rule needed.
//
// <app_data>/context-ratings.json, localStorage mirror like the other stores.

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { artistsOf } from "./artists";
import type { Track } from "./nowPlaying";

const inTauri = "__TAURI_INTERNALS__" in window;
const FILE = "context-ratings.json";
const LS = "vizzy.ctxratings.v1";

export type Scope = "song" | "artist" | "playlist";
type Table = Record<string, Record<string, number>>; // context id → preset key → -3..3

type Data = {
  version: 1;
  enabled: boolean;
  song: Table;
  artist: Table;
  playlist: Table;
};

const EMPTY: Data = { version: 1, enabled: true, song: {}, artist: {}, playlist: {} };

/** How strongly one step counts per scope in the pick weight (base^rating). */
const BASE: Record<Scope, number> = { song: 2, playlist: 1.6, artist: 1.4 };
/** Same idea as a score for "does this song have a clear favourite". */
const SCORE: Record<Scope, number> = { song: 1.25, playlist: 0.6, artist: 0.4 };
/** score a preset needs before it is put up at the start of the song:
 *  two + on the song itself, or +3 on both its artist and playlist */
export const LEARNED_START = 2.5;

/** The context ids of a track, per scope. */
export function contextIds(t: Track): Record<Scope, string[]> {
  return {
    song: [...new Set([t.key, t.baseKey])],
    artist: artistsOf(t.artist),
    playlist: t.context ? [t.context.uri] : [],
  };
}

class ContextRatings {
  private data: Data = EMPTY;
  private listeners = new Set<() => void>();

  constructor() {
    try {
      const s = localStorage.getItem(LS);
      if (s) this.data = { ...EMPTY, ...JSON.parse(s) };
    } catch {
      // ignore
    }
    if (inTauri) {
      invoke<string | null>("data_read", { name: FILE })
        .then((s) => {
          if (s) this.set({ ...EMPTY, ...JSON.parse(s) }, false);
        })
        .catch(() => {});
    }
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = () => this.data;

  private set(d: Data, save = true) {
    this.data = d;
    for (const fn of this.listeners) fn();
    if (!save) return;
    const json = JSON.stringify(d);
    try {
      localStorage.setItem(LS, json);
    } catch {
      // ignore
    }
    if (inTauri) void invoke("data_write", { name: FILE, contents: json }).catch(() => {});
  }

  get enabled() {
    return this.data.enabled;
  }

  setEnabled(enabled: boolean) {
    this.set({ ...this.data, enabled });
  }

  /** One + or - for `preset` in every context of `t`. Returns the scopes it went into. */
  rate(t: Track, preset: string, dir: 1 | -1): Scope[] {
    if (!this.data.enabled) return [];
    const ids = contextIds(t);
    const next: Data = { ...this.data };
    const done: Scope[] = [];
    for (const scope of ["song", "artist", "playlist"] as Scope[]) {
      // a song under every key it is known by (spotify id and smtc), so it
      // is found at once on the next play, before Spotify has answered;
      // lookups take the strongest value per scope, nothing counts twice
      const list = ids[scope];
      if (list.length === 0) continue;
      const table: Table = { ...next[scope] };
      for (const id of list) {
        const row = { ...(table[id] ?? {}) };
        const v = Math.max(-3, Math.min(3, (row[preset] ?? 0) + dir));
        if (v === 0) delete row[preset];
        else row[preset] = v;
        if (Object.keys(row).length) table[id] = row;
        else delete table[id];
      }
      next[scope] = table;
      done.push(scope);
    }
    this.set(next);
    return done;
  }

  /** The rating of `preset` per scope for this track (strongest artist wins). */
  ratingsFor(t: Track, preset: string): Record<Scope, number> {
    const ids = contextIds(t);
    const pick = (scope: Scope) => {
      let best = 0;
      for (const id of ids[scope]) {
        const v = this.data[scope][id]?.[preset] ?? 0;
        if (Math.abs(v) > Math.abs(best)) best = v;
      }
      return best;
    };
    return { song: pick("song"), artist: pick("artist"), playlist: pick("playlist") };
  }

  /** Multiplier for the pick weight; 1 = nothing learned. */
  weight(t: Track | null, preset: string): number {
    if (!t || !this.data.enabled) return 1;
    const r = this.ratingsFor(t, preset);
    return Math.pow(BASE.song, r.song) * Math.pow(BASE.playlist, r.playlist) * Math.pow(BASE.artist, r.artist);
  }

  score(t: Track, preset: string): number {
    const r = this.ratingsFor(t, preset);
    return r.song * SCORE.song + r.playlist * SCORE.playlist + r.artist * SCORE.artist;
  }

  /** Every preset anything is known about for this track, best first. */
  known(t: Track): { preset: string; score: number; r: Record<Scope, number> }[] {
    const ids = contextIds(t);
    const keys = new Set<string>();
    for (const scope of ["song", "artist", "playlist"] as Scope[])
      for (const id of ids[scope]) for (const k of Object.keys(this.data[scope][id] ?? {})) keys.add(k);
    return [...keys]
      .map((preset) => ({ preset, score: this.score(t, preset), r: this.ratingsFor(t, preset) }))
      .sort((a, b) => b.score - a.score);
  }

  /** Clear one preset's learned values for this track, in one scope. */
  forget(t: Track, preset: string, scope: Scope) {
    const ids = contextIds(t)[scope];
    const table: Table = { ...this.data[scope] };
    for (const id of ids) {
      if (!table[id]?.[preset]) continue;
      const row = { ...table[id] };
      delete row[preset];
      if (Object.keys(row).length) table[id] = row;
      else delete table[id];
    }
    this.set({ ...this.data, [scope]: table });
  }

  forgetAll() {
    this.set({ ...EMPTY, enabled: this.data.enabled });
  }

  /** How many songs / artists / playlists something was learned for. A song
   *  sits under its smtc key (always) and maybe its spotify id — count once. */
  counts(): Record<Scope, number> {
    return {
      song: Object.keys(this.data.song).filter((k) => k.startsWith("smtc:")).length,
      artist: Object.keys(this.data.artist).length,
      playlist: Object.keys(this.data.playlist).length,
    };
  }
}

export const contextRatings = new ContextRatings();

export function useContextRatings() {
  return useSyncExternalStore(contextRatings.subscribe, contextRatings.getSnapshot);
}
