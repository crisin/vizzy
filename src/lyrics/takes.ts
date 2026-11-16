// Takes: what the lyrics worker heard per song, with song times — one JSON
// file each in <app_data>/lyrics-takes (src-tauri/src/lyrics_take.rs,
// PLAN-aufnahme.md). The worker writes them; this lists and deletes them
// through the plain data_* commands, and sends them to Lyrics Helper — by
// hand, or by itself when a song is over (the request runs in Rust, where
// the token lives).

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { newHelper, type NhSongInfo } from "../regie/newHelper";
import { lyrics } from "./store";

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
  /** set by the upload: when it went to Lyrics Helper, with how many lines */
  uploaded?: { at: string; lines: number };
};

/** Where a take stands with Lyrics Helper. */
export type TakeState = "local" | "uploaded" | "changed" | "noId";

export function takeState(t: TakeFile): TakeState {
  if (!t.spotifyId) return "noId";
  if (!t.uploaded) return "local";
  // the worker rewrites a take while its song plays, which drops the note;
  // a different line count means it was edited by hand since
  return t.uploaded.lines === t.lines.length ? "uploaded" : "changed";
}

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
    name: `${DIR}/demo-3.json`,
    take: {
      v: 1, spotifyId: "0VjIjW4GlUZAMYd2vXMi3b", artist: "The Weeknd", title: "Blinding Lights", durationMs: 200_000,
      recordedAt: new Date(Date.now() - 7_200_000).toISOString(), clock: "media",
      coverage: { fromMs: 12_000, toMs: 190_000 }, heardMs: 196_000,
      lines: Array.from({ length: 30 }, (_, i) => ({ text: "…", startMs: i * 6000, endMs: i * 6000 + 3000, repeat: false })),
      uploaded: { at: new Date(Date.now() - 7_000_000).toISOString(), lines: 30 },
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

/** What the list shows besides the files: uploads under way, what went wrong. */
export type TakesUi = { busy: Record<string, boolean>; errors: Record<string, string> };

class Takes {
  private snap: TakeEntry[] = inTauri ? [] : DEMO;
  private ui: TakesUi = { busy: {}, errors: {} };
  private listeners = new Set<() => void>();
  private loading = false;

  constructor() {
    if (!inTauri) return;
    // the worker says when a new file appears…
    void listen("lyrics-takes", () => this.refresh());
    // …and when a song is over and its take complete
    void listen<string>("lyrics-take-done", (e) => void this.done(e.payload));
  }

  getUi = () => this.ui;

  private setUi(name: string, busy: boolean, error?: string) {
    const errors = { ...this.ui.errors };
    if (error) errors[name] = error;
    else delete errors[name];
    this.ui = { busy: { ...this.ui.busy, [name]: busy }, errors };
    for (const fn of this.listeners) fn();
  }

  /** Sends a take to Lyrics Helper. The file notes that it went up. */
  async upload(name: string): Promise<boolean> {
    if (this.ui.busy[name]) return false;
    this.setUi(name, true);
    try {
      if (inTauri) await invoke("newhelper_upload_take", { name });
      else {
        // browser demo: pretend
        await new Promise((r) => setTimeout(r, 600));
        this.set(this.snap.map((e) => (e.name === name ? { ...e, take: { ...e.take, uploaded: { at: new Date().toISOString(), lines: e.take.lines.length } } } : e)));
      }
      this.setUi(name, false);
      await this.refresh();
      return true;
    } catch (e) {
      this.setUi(name, false, String(e));
      return false;
    }
  }

  /** A song is over: upload its take if the setting says so. */
  private async done(name: string) {
    await this.refresh();
    const mode = lyrics.getSnapshot().cfg.takesUpload;
    if (!mode || !newHelper.configured) return;
    const take = this.snap.find((e) => e.name === name)?.take;
    if (!take?.spotifyId || takeState(take) === "uploaded") return;
    if (mode === 1) {
      // only where Lyrics Helper has no synced lyrics yet; when it cannot be
      // asked, the take waits in the list
      try {
        const info = await invoke<NhSongInfo>("newhelper_song", { spotifyId: take.spotifyId, title: take.title, artist: take.artist });
        if (info.found && (info.lines ?? []).some((l) => l.startMs !== null)) return;
      } catch {
        return;
      }
    }
    await this.upload(name);
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

export function useTakesUi(): TakesUi {
  return useSyncExternalStore(takes.subscribe, takes.getUi);
}
