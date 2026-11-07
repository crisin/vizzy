// What song is playing — fed by the Rust side (`src-tauri/src/nowplaying.rs`,
// Windows media session for now; Spotify Web API comes next and will merge
// in here). Everything that wants to react to songs listens to this store:
// the cockpit, later the rule engine ("Regie").
//
// A song change is the moment the identity (`trackKey`) changes, or the same
// track restarts from the top. It also replaces the silence heuristic in
// `live` as the "new track" signal while metadata is flowing.

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { live } from "../milkdrop/live";

const inTauri = "__TAURI_INTERNALS__" in window;
const LS = "vizzy.nowplaying.v1";

/** As sent by Rust (camelCase). */
export type RawNowPlaying = {
  app: string;
  title: string;
  artist: string;
  album: string;
  status: "playing" | "paused" | "stopped" | "other";
  positionMs: number | null;
  durationMs: number | null;
  /** unix ms the position was sampled at */
  sampledAt: number;
};

export type Track = RawNowPlaying & {
  /** stable identity: `smtc:<artist>|<title>`; `spotify:track:<id>` once the API is in */
  key: string;
  /** "Spotify", "Chrome", … for display */
  appLabel: string;
};

export type MediaSession = { app: string; title: string; artist: string; status: string };

type Persisted = { prefer: string | null; history: HistoryEntry[] };
export type HistoryEntry = { key: string; title: string; artist: string; app: string; at: number };

type Snapshot = {
  track: Track | null;
  /** performance.now() of the last song change, 0 = none yet */
  changedAt: number;
  prefer: string | null;
  history: HistoryEntry[];
};

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/\s+/g, " ")
    .trim();

export function trackKeyOf(artist: string, title: string): string {
  return `smtc:${norm(artist)}|${norm(title)}`;
}

/** "Spotify.exe" → "Spotify", "Microsoft.ZuneMusic_8wekyb3d8bbwe!…" → "ZuneMusic" */
export function appLabel(app: string): string {
  const id = app.split("!")[0];
  const last = id.split(/[\\/]/).pop() ?? id;
  const base = last.replace(/\.exe$/i, "").replace(/_[a-z0-9]{13}$/i, "");
  const parts = base.split(".");
  const name = parts[parts.length - 1] || base;
  return /^msedge$/i.test(name) ? "Edge" : name.charAt(0).toUpperCase() + name.slice(1);
}

/** Spotify free publishes its ads as tracks — they must not count as songs. */
function isAd(np: RawNowPlaying): boolean {
  return /spotify/i.test(np.app) && (!np.artist || /^(advertisement|spotify)$/i.test(np.title));
}

class NowPlayingStore {
  private snap: Snapshot;
  private listeners = new Set<() => void>();
  private songListeners = new Set<(t: Track) => void>();

  constructor() {
    let saved: Persisted = { prefer: null, history: [] };
    try {
      saved = { ...saved, ...JSON.parse(localStorage.getItem(LS) ?? "{}") };
    } catch {
      // ignore
    }
    this.snap = { track: null, changedAt: 0, prefer: saved.prefer, history: saved.history ?? [] };
    if (inTauri) {
      void listen<RawNowPlaying | null>("nowplaying", (e) => this.ingest(e.payload));
      void invoke("nowplaying_prefer", { app: saved.prefer }).catch(() => {});
      void invoke<RawNowPlaying | null>("nowplaying_get")
        .then((np) => this.ingest(np))
        .catch(() => {});
    }
    if (import.meta.env.DEV) {
      // browser preview / manual testing: window.__vizzyNowPlaying({...})
      (window as unknown as Record<string, unknown>).__vizzyNowPlaying = (np: Partial<RawNowPlaying> | null) =>
        this.ingest(
          np && {
            app: "Spotify.exe",
            title: "",
            artist: "",
            album: "",
            status: "playing",
            positionMs: 0,
            durationMs: 200_000,
            sampledAt: Date.now(),
            ...np,
          },
        );
    }
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = () => this.snap;

  /** Called once per song change (not on pause/seek). */
  onSongChange(fn: (t: Track) => void): () => void {
    this.songListeners.add(fn);
    return () => {
      this.songListeners.delete(fn);
    };
  }

  setPrefer(app: string | null) {
    this.snap = { ...this.snap, prefer: app };
    this.persist();
    this.emit();
    if (inTauri) void invoke("nowplaying_prefer", { app }).catch(() => {});
  }

  async sessions(): Promise<MediaSession[]> {
    if (!inTauri) return [];
    return invoke<MediaSession[]>("nowplaying_sessions").catch(() => []);
  }

  private ingest(np: RawNowPlaying | null) {
    const prev = this.snap.track;
    if (!np || !np.title || isAd(np)) {
      live.metaActive = false;
      // keep `track` for an ad so the cockpit doesn't flicker, but mark it idle
      this.snap = { ...this.snap, track: np && prev ? { ...prev, status: "other" } : null };
      this.emit();
      return;
    }
    const track: Track = { ...np, key: trackKeyOf(np.artist, np.title), appLabel: appLabel(np.app) };
    const restarted =
      prev?.key === track.key &&
      (positionNow(prev) ?? 0) > 20_000 &&
      track.positionMs !== null &&
      track.positionMs < 3_000;
    const isNew = prev?.key !== track.key || restarted;

    live.metaActive = track.status === "playing";
    let { changedAt, history } = this.snap;
    if (isNew) {
      changedAt = performance.now();
      live.markTrackStart();
      history = [
        { key: track.key, title: track.title, artist: track.artist, app: track.appLabel, at: Date.now() },
        ...history.filter((h) => h.key !== track.key),
      ].slice(0, 50);
    }
    this.snap = { ...this.snap, track, changedAt, history };
    if (isNew) this.persist();
    this.emit();
    if (isNew) for (const fn of this.songListeners) fn(track);
  }

  private persist() {
    const p: Persisted = { prefer: this.snap.prefer, history: this.snap.history };
    try {
      localStorage.setItem(LS, JSON.stringify(p));
    } catch {
      // ignore
    }
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }
}

/** Position right now, interpolated from the last sample while playing. */
export function positionNow(t: Track | null): number | null {
  if (!t || t.positionMs === null) return null;
  const p = t.status === "playing" ? t.positionMs + (Date.now() - t.sampledAt) : t.positionMs;
  return t.durationMs ? Math.min(Math.max(0, p), t.durationMs) : Math.max(0, p);
}

export const nowPlaying = new NowPlayingStore();

export function useNowPlaying(): Snapshot {
  return useSyncExternalStore(nowPlaying.subscribe, nowPlaying.getSnapshot);
}
