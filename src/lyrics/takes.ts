// Takes: what the lyrics worker heard per song, with song times — one JSON
// file each in <app_data>/lyrics-takes (src-tauri/src/lyrics_take.rs,
// PLAN-aufnahme.md). The worker writes them; this lists and deletes them
// through the plain data_* commands.

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const inTauri = "__TAURI_INTERNALS__" in window;
const DIR = "lyrics-takes";

/** One file, as the worker writes it. */
export type TakeFile = {
  v: number;
  spotifyId: string | null;
  artist: string;
  title: string;
  durationMs: number | null;
  recordedAt: string;
  /** "media": timed by the media position; "songchange": only by the time since the song began */
  clock: "media" | "songchange";
  coverage: { fromMs: number; toMs: number };
  heardMs: number;
  lines: { text: string; startMs: number; endMs: number; repeat: boolean }[];
};

export type TakeEntry = {
  /** `lyrics-takes/<file>.json` */
  name: string;
  take: TakeFile;
};

/** Share of the song heard, 0–1, or null without a duration. */
export function heardShare(t: TakeFile): number | null {
  return t.durationMs ? Math.min(1, t.heardMs / t.durationMs) : null;
}

const DEMO: TakeEntry[] = [
  {
    name: `${DIR}/demo-1.json`,
    take: {
      v: 1, spotifyId: "2WfaOiMkCvy7F5fcp2zZ8L", artist: "a-ha", title: "Take On Me", durationMs: 225_000,
      recordedAt: new Date(Date.now() - 3_600_000).toISOString(), clock: "media",
      coverage: { fromMs: 31_000, toMs: 214_000 }, heardMs: 221_000,
      lines: Array.from({ length: 38 }, (_, i) => ({ text: "Take on me", startMs: i * 5000, endMs: i * 5000 + 3000, repeat: false })),
    },
  },
  {
    name: `${DIR}/demo-2.json`,
    take: {
      v: 1, spotifyId: null, artist: "", title: "Ein Stream ohne Spotify", durationMs: null,
      recordedAt: new Date(Date.now() - 86_400_000).toISOString(), clock: "songchange",
      coverage: { fromMs: 2_000, toMs: 95_000 }, heardMs: 98_000,
      lines: Array.from({ length: 12 }, (_, i) => ({ text: "…", startMs: i * 7000, endMs: i * 7000 + 3000, repeat: false })),
    },
  },
];

class Takes {
  private snap: TakeEntry[] = inTauri ? [] : DEMO;
  private listeners = new Set<() => void>();
  private loading = false;

  constructor() {
    if (!inTauri) return;
    // the worker says when a new file appears
    void listen("lyrics-takes", () => this.refresh());
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = () => this.snap;

  private set(list: TakeEntry[]) {
    this.snap = list;
    for (const fn of this.listeners) fn();
  }

  /** Reads the folder again, newest first. */
  async refresh() {
    if (!inTauri || this.loading) return;
    this.loading = true;
    try {
      const files = await invoke<{ name: string }[]>("data_list", { dir: DIR });
      const out: TakeEntry[] = [];
      for (const f of files) {
        try {
          const text = await invoke<string | null>("data_read", { name: f.name });
          const take = text ? (JSON.parse(text) as TakeFile) : null;
          if (take && Array.isArray(take.lines)) out.push({ name: f.name, take });
        } catch {
          // a file that is not a take (hand-edited, half written): skipped
        }
      }
      out.sort((a, b) => b.take.recordedAt.localeCompare(a.take.recordedAt));
      this.set(out);
    } catch {
      // the list stays as it was
    } finally {
      this.loading = false;
    }
  }

  /** Deletes the file; the returned function puts it back. */
  async remove(entry: TakeEntry): Promise<() => void> {
    this.set(this.snap.filter((e) => e.name !== entry.name));
    if (inTauri) await invoke("data_delete", { name: entry.name });
    return () => {
      const back = async () => {
        if (inTauri) await invoke("data_write", { name: entry.name, contents: JSON.stringify(entry.take, null, 2) });
        else this.set([...this.snap, entry].sort((a, b) => b.take.recordedAt.localeCompare(a.take.recordedAt)));
        await this.refresh();
      };
      void back();
    };
  }

  openFolder() {
    if (inTauri) void invoke("data_open_dir", { dir: DIR }).catch(() => {});
  }
}

export const takes = new Takes();

export function useTakes(): TakeEntry[] {
  return useSyncExternalStore(takes.subscribe, takes.getSnapshot);
}
