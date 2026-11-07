// Song choreographies: for one song, which picture comes when.
// A cue fires at a song time (optionally snapped to the next beat or bar
// when it plays) or at the n-th detected section change. The director
// plays them (queue > choreo > rules > auto); recording writes every
// picture change while the song plays as a cue.
//
// <app_data>/choreos.json, localStorage mirror.

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Track } from "./nowPlaying";

const inTauri = "__TAURI_INTERNALS__" in window;
const FILE = "choreos.json";
const LS = "vizzy.choreos.v1";

export type Anchor = "time" | "section";
export type Snap = "none" | "beat" | "bar";

export type Cue = {
  id: string;
  /** song time in ms — for section cues the time the section was heard at,
   *  used for ordering and drawing */
  t: number;
  anchor: Anchor;
  /** section anchors: fires on the n-th section change (0 = song start) */
  section?: number;
  /** time anchors: wait for the next beat / bar after `t` */
  snap: Snap;
  /** preset key or `combo:<name>` */
  ref: string;
};

export type Choreo = {
  /** source-independent song key (baseKey) */
  key: string;
  /** every key the song is known under (spotify id, smtc) */
  keys: string[];
  title: string;
  artist: string;
  durationMs: number;
  enabled: boolean;
  cues: Cue[];
  updated: number;
};

type File = { version: 1; choreos: Choreo[] };

export type RecState = { key: string; title: string } | null;

let idn = 0;
const cueId = () => `c${Date.now().toString(36)}${(idn++).toString(36)}`;

const byTime = (a: Cue, b: Cue) => a.t - b.t;

class ChoreoStore {
  private list: Choreo[] = [];
  private rec: RecState = null;
  private listeners = new Set<() => void>();
  private recListeners = new Set<() => void>();

  constructor() {
    try {
      const s = localStorage.getItem(LS);
      if (s) this.list = (JSON.parse(s) as File).choreos ?? [];
    } catch {
      this.list = [];
    }
    if (inTauri) {
      invoke<string | null>("data_read", { name: FILE })
        .then((s) => {
          if (s) this.set((JSON.parse(s) as File).choreos ?? [], false);
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
  getSnapshot = () => this.list;

  subscribeRec = (fn: () => void) => {
    this.recListeners.add(fn);
    return () => {
      this.recListeners.delete(fn);
    };
  };
  getRec = () => this.rec;

  private set(list: Choreo[], save = true) {
    this.list = list;
    for (const fn of this.listeners) fn();
    if (!save) return;
    const json = JSON.stringify({ version: 1, choreos: list } satisfies File);
    try {
      localStorage.setItem(LS, json);
    } catch {
      // ignore
    }
    if (inTauri) void invoke("data_write", { name: FILE, contents: json }).catch(() => {});
  }

  get(key: string): Choreo | undefined {
    return this.list.find((c) => c.key === key);
  }

  find(t: Track | null): Choreo | undefined {
    if (!t) return undefined;
    return this.list.find((c) => c.key === t.baseKey || c.keys.includes(t.key));
  }

  /** The choreo for this song, created empty if there is none yet. */
  ensure(t: Pick<Track, "baseKey" | "key" | "title" | "artist" | "durationMs">): Choreo {
    const found = this.list.find((c) => c.key === t.baseKey);
    if (found) {
      // learn the spotify id once it is known
      if (!found.keys.includes(t.key)) this.patch(found.key, { keys: [...found.keys, t.key] });
      return this.get(found.key)!;
    }
    const c: Choreo = {
      key: t.baseKey,
      keys: [...new Set([t.baseKey, t.key])],
      title: t.title,
      artist: t.artist,
      durationMs: t.durationMs ?? 0,
      enabled: true,
      cues: [],
      updated: Date.now(),
    };
    this.set([...this.list, c]);
    return c;
  }

  patch(key: string, p: Partial<Choreo>) {
    this.set(this.list.map((c) => (c.key === key ? { ...c, ...p, updated: Date.now() } : c)));
  }

  remove(key: string) {
    if (this.rec?.key === key) this.stopRecording();
    this.set(this.list.filter((c) => c.key !== key));
  }

  addCue(key: string, cue: Omit<Cue, "id">): Cue {
    const c = this.get(key);
    const full = { ...cue, id: cueId() };
    if (c) this.patch(key, { cues: [...c.cues, full].sort(byTime) });
    return full;
  }

  updateCue(key: string, id: string, p: Partial<Cue>) {
    const c = this.get(key);
    if (c) this.patch(key, { cues: c.cues.map((x) => (x.id === id ? { ...x, ...p } : x)).sort(byTime) });
  }

  removeCue(key: string, id: string) {
    const c = this.get(key);
    if (c) this.patch(key, { cues: c.cues.filter((x) => x.id !== id) });
  }

  // ---- recording

  private setRec(r: RecState) {
    this.rec = r;
    for (const fn of this.recListeners) fn();
  }

  /** Start recording at `posMs`: later cues go, the running picture is the first new one. */
  startRecording(t: Track, posMs: number, currentRef: string) {
    const c = this.ensure(t);
    const keep = c.cues.filter((x) => x.t < posMs - 500);
    this.patch(c.key, {
      cues: [...keep, { id: cueId(), t: Math.round(posMs), anchor: "time", snap: "beat", ref: currentRef } as Cue].sort(
        byTime,
      ),
      enabled: true,
    });
    this.setRec({ key: c.key, title: t.title });
  }

  stopRecording() {
    if (this.rec) this.setRec(null);
  }

  /** A picture change while recording. Quick flips replace the last cue. */
  record(t: Track, posMs: number, ref: string) {
    const r = this.rec;
    if (!r || r.key !== t.baseKey) return;
    const c = this.get(r.key);
    if (!c) return;
    const before = c.cues.filter((x) => x.t <= posMs);
    const last = before[before.length - 1];
    if (last?.ref === ref) return;
    if (last && posMs - last.t < 1500) {
      this.updateCue(r.key, last.id, { ref });
      return;
    }
    this.addCue(r.key, { t: Math.round(posMs), anchor: "time", snap: "beat", ref });
  }
}

export const choreos = new ChoreoStore();

export function useChoreos(): Choreo[] {
  return useSyncExternalStore(choreos.subscribe, choreos.getSnapshot);
}

export function useRecording(): RecState {
  return useSyncExternalStore(choreos.subscribeRec, choreos.getRec);
}

/** The section index a song time falls into (0 = before the first change). */
export function sectionAt(sections: number[], t: number): number {
  let n = 0;
  for (const s of sections) if (s <= t + 250) n++;
  return n;
}

if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__vizzyChoreos = choreos;
}
