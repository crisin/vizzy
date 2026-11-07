// new-helper as an optional data source (client in Rust: src-tauri/src/newhelper.rs).
// For the playing song it fetches tags / mood / saved / lyric sections; the
// director matches "tag" rules against them, the choreo timeline shows the
// lyric sections. Without configuration nothing happens.

import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { nowPlaying, type Track } from "./nowPlaying";

const inTauri = "__TAURI_INTERNALS__" in window;

export type NhTag = { tag: string; type: "CONTEXT" | "MOOD" };

export type NhSongInfo = {
  found: boolean;
  spotifyId: string | null;
  title: string | null;
  artist: string | null;
  tags: NhTag[];
  saved: boolean;
  isFavorite: boolean;
  sections: { label: string; startMs: number | null }[];
};

export type NhStatus = { baseUrl: string; hasToken: boolean };

type Snapshot = {
  status: NhStatus;
  /** by song baseKey */
  info: Record<string, NhSongInfo>;
  error: string | null;
};

type SongQuery = Pick<Track, "baseKey" | "title" | "artist"> & { spotifyId?: string | null };

class NewHelperStore {
  private snap: Snapshot = { status: { baseUrl: "", hasToken: false }, info: {}, error: null };
  private listeners = new Set<() => void>();
  /** baseKey|spotifyId already asked for */
  private asked = new Set<string>();

  constructor() {
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__vizzyNewHelper = this;
    }
    if (!inTauri) return;
    void invoke<NhStatus>("newhelper_status")
      .then((status) => {
        this.set({ status });
        this.follow();
      })
      .catch(() => {});
    nowPlaying.subscribe(() => this.follow());
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = () => this.snap;

  private set(p: Partial<Snapshot>) {
    this.snap = { ...this.snap, ...p };
    for (const fn of this.listeners) fn();
  }

  get configured() {
    return !!this.snap.status.baseUrl && this.snap.status.hasToken;
  }

  /** The playing song: ask once per song, again when Spotify adds its id. */
  private follow() {
    const t = nowPlaying.getSnapshot().track;
    if (!t || t.status === "other") return;
    void this.ensure({ baseKey: t.baseKey, title: t.title, artist: t.artist, spotifyId: t.spotifyId });
  }

  async ensure(q: SongQuery): Promise<NhSongInfo | null> {
    if (!inTauri || !this.configured) return null;
    const ask = `${q.baseKey}|${q.spotifyId ?? ""}`;
    if (this.asked.has(ask)) return this.snap.info[q.baseKey] ?? null;
    // with an id we only ask again if the title lookup found nothing
    if (q.spotifyId && this.snap.info[q.baseKey]?.found) return this.snap.info[q.baseKey];
    this.asked.add(ask);
    try {
      const info = await invoke<NhSongInfo>("newhelper_song", {
        spotifyId: q.spotifyId ?? null,
        title: q.title,
        artist: q.artist.split(",")[0].trim(),
      });
      this.set({ info: { ...this.snap.info, [q.baseKey]: info }, error: null });
      return info;
    } catch (e) {
      this.asked.delete(ask);
      this.set({ error: String(e) });
      return null;
    }
  }

  /** dev/preview only: pretend new-helper answered */
  devInject(baseKey: string, info: NhSongInfo) {
    this.set({ status: { baseUrl: "http://dev", hasToken: true }, info: { ...this.snap.info, [baseKey]: info } });
  }

  infoFor(t: Track | null): NhSongInfo | null {
    return t ? (this.snap.info[t.baseKey] ?? null) : null;
  }

  async configure(baseUrl: string, token: string | null): Promise<string | null> {
    if (!inTauri) return null;
    const status = await invoke<NhStatus>("newhelper_configure", { baseUrl, token });
    this.asked.clear();
    this.set({ status, info: {}, error: null });
    try {
      await invoke("newhelper_test");
      this.follow();
      return null;
    } catch (e) {
      this.set({ error: String(e) });
      return String(e);
    }
  }

  async test(): Promise<string | null> {
    try {
      await invoke("newhelper_test");
      this.set({ error: null });
      return null;
    } catch (e) {
      this.set({ error: String(e) });
      return String(e);
    }
  }
}

export const newHelper = new NewHelperStore();

export function useNewHelper(): Snapshot {
  return useSyncExternalStore(newHelper.subscribe, newHelper.getSnapshot);
}

/** new-helper's info for any song (fetched on demand, e.g. in the choreo editor). */
export function useNhSong(q: SongQuery | null): NhSongInfo | null {
  const snap = useNewHelper();
  const key = q?.baseKey ?? "";
  useEffect(() => {
    if (q) void newHelper.ensure(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, q?.spotifyId, snap.status]);
  return q ? (snap.info[q.baseKey] ?? null) : null;
}
