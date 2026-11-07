// What song is playing — merged from two sources:
//  - the OS media session (`src-tauri/src/nowplaying.rs`): instant, no login,
//    any player — but only title/artist/position;
//  - the Spotify Web API (`src-tauri/src/spotify.rs`, see `spotify.ts`):
//    polled, needs login — adds a stable track id and the context
//    (which playlist/album it plays from), and works across devices.
// When both describe the same song they merge into one `Track` whose `key`
// is the Spotify id. Without a media session (another device, the Mac)
// Spotify alone is the source.
//
// A song change is the moment the song identity (`baseKey`, from title +
// main artist) changes, or the same song restarts from the top. The upgrade
// from `smtc:` to `spotify:track:` key a moment later is NOT a new song.
// It also replaces the silence heuristic in `live` as the "new track" signal.

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { live } from "../milkdrop/live";
import { spotify, type SpotifyContext, type SpotifyNow } from "./spotify";

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
  /** best identity: `spotify:track:<id>` when known, else `baseKey` */
  key: string;
  /** source-independent identity: `smtc:<main artist>|<title>` */
  baseKey: string;
  /** "Spotify", "Chrome", … for display */
  appLabel: string;
  /** where it came from: media session, Spotify API, or both merged */
  via: "media" | "spotify" | "both";
  spotifyId: string | null;
  context: SpotifyContext | null;
};

export type MediaSession = { app: string; title: string; artist: string; status: string };

export type HistoryEntry = {
  key: string;
  title: string;
  artist: string;
  app: string;
  at: number;
  /** Spotify context name, e.g. the playlist */
  ctx?: string;
};
type Persisted = { prefer: string | null; history: HistoryEntry[] };

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

/** "Dr. Dre, Snoop Dogg" / "A feat. B" / "A & B" → "dr. dre" */
function mainArtist(artist: string): string {
  return norm(artist.split(/\s*(?:,|;|&|\bfeat\.?|\bft\.?|\bx\b)\s*/i)[0] ?? artist);
}

export function trackKeyOf(artist: string, title: string): string {
  return `smtc:${mainArtist(artist)}|${norm(title)}`;
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

function sameSong(np: RawNowPlaying, sp: SpotifyNow): boolean {
  return norm(np.title) === norm(sp.title) && mainArtist(np.artist) === mainArtist(sp.artists[0] ?? "");
}

const CONTEXT_LABEL: Record<string, string> = {
  playlist: "Playlist",
  album: "Album",
  artist: "Artist",
  collection: "Bibliothek",
  show: "Podcast",
};
export function contextLabel(c: SpotifyContext): string {
  return `${CONTEXT_LABEL[c.kind] ?? c.kind}: ${c.name ?? "?"}`;
}

class NowPlayingStore {
  private snap: Snapshot;
  private media: RawNowPlaying | null = null;
  private sp: SpotifyNow | null = null;
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
      void listen<RawNowPlaying | null>("nowplaying", (e) => this.ingestMedia(e.payload));
      void listen<SpotifyNow | null>("spotify", (e) => this.ingestSpotify(e.payload));
      void invoke("nowplaying_prefer", { app: saved.prefer }).catch(() => {});
      void invoke<RawNowPlaying | null>("nowplaying_get")
        .then((np) => this.ingestMedia(np))
        .catch(() => {});
      void invoke<SpotifyNow | null>("spotify_now")
        .then((sp) => this.ingestSpotify(sp))
        .catch(() => {});
    }
    if (import.meta.env.DEV) {
      // browser preview / manual testing:
      //   window.__vizzyNowPlaying({title, artist, …})  — media session
      //   window.__vizzySpotify({trackId, title, artists, context, …})
      const w = window as unknown as Record<string, unknown>;
      w.__vizzyNowPlaying = (np: Partial<RawNowPlaying> | null) =>
        this.ingestMedia(
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
      w.__vizzySpotify = (sp: Partial<SpotifyNow> | null) =>
        this.ingestSpotify(
          sp && {
            trackId: "dev",
            uri: "spotify:track:dev",
            title: "",
            artists: [],
            album: "",
            durationMs: 200_000,
            progressMs: 0,
            isPlaying: true,
            sampledAt: Date.now(),
            context: null,
            ...sp,
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

  /** Called once per song change (not on pause/seek, not on the id upgrade). */
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

  private ingestMedia(np: RawNowPlaying | null) {
    const prevBase = this.media && trackKeyOf(this.media.artist, this.media.title);
    this.media = np;
    // a new song in the media session: don't wait 4–15 s for the next poll
    if (np?.title && trackKeyOf(np.artist, np.title) !== prevBase) spotify.pollNow();
    this.recompute();
  }

  private ingestSpotify(sp: SpotifyNow | null) {
    this.sp = sp;
    this.recompute();
  }

  /** The merged view of both sources. */
  private merged(): Track | null {
    const m = this.media && this.media.title && !isAd(this.media) ? this.media : null;
    const sp = this.sp;
    // a paused local player loses against Spotify playing something else
    // (e.g. on the phone)
    const mediaWins = m && !(m.status !== "playing" && sp?.isPlaying && !sameSong(m, sp));
    if (m && mediaWins) {
      const match = sp && sameSong(m, sp) ? sp : null;
      const baseKey = trackKeyOf(m.artist, m.title);
      return {
        ...m,
        // the media session's own timeline is often coarse — prefer Spotify's
        ...(match && {
          positionMs: match.progressMs,
          sampledAt: match.sampledAt,
          durationMs: match.durationMs || m.durationMs,
        }),
        baseKey,
        key: match ? `spotify:track:${match.trackId}` : baseKey,
        appLabel: appLabel(m.app),
        via: match ? "both" : "media",
        spotifyId: match?.trackId ?? null,
        context: match?.context ?? null,
      };
    }
    // nothing usable in the media session (other device, other OS, an ad):
    // Spotify alone, as long as it actually plays
    if (sp && sp.isPlaying && !(this.media && isAd(this.media))) {
      const artist = sp.artists.join(", ");
      return {
        app: "Spotify (Web API)",
        title: sp.title,
        artist,
        album: sp.album,
        status: "playing",
        positionMs: sp.progressMs,
        durationMs: sp.durationMs,
        sampledAt: sp.sampledAt,
        baseKey: trackKeyOf(artist, sp.title),
        key: `spotify:track:${sp.trackId}`,
        appLabel: "Spotify",
        via: "spotify",
        spotifyId: sp.trackId,
        context: sp.context,
      };
    }
    return null;
  }

  private recompute() {
    const prev = this.snap.track;
    const track = this.merged();
    if (!track) {
      live.metaActive = false;
      // an ad: keep the last track so the cockpit doesn't flicker, but idle
      const ad = this.media && isAd(this.media);
      this.snap = { ...this.snap, track: ad && prev ? { ...prev, status: "other" } : null };
      this.emit();
      return;
    }
    const restarted =
      prev?.baseKey === track.baseKey &&
      (positionNow(prev) ?? 0) > 20_000 &&
      track.positionMs !== null &&
      track.positionMs < 3_000;
    const isNew = prev?.baseKey !== track.baseKey || restarted;
    // same song, but now we know more (Spotify id, playlist)
    const upgraded = !isNew && (prev?.key !== track.key || prev?.context?.uri !== track.context?.uri);

    live.metaActive = track.status === "playing";
    let { changedAt, history } = this.snap;
    const entry: HistoryEntry = {
      key: track.key,
      title: track.title,
      artist: track.artist,
      app: track.appLabel,
      at: Date.now(),
      ...(track.context?.name && { ctx: contextLabel(track.context) }),
    };
    if (isNew) {
      changedAt = performance.now();
      live.markTrackStart();
      history = [entry, ...history.filter((h) => h.key !== track.key && h.key !== track.baseKey)].slice(0, 50);
    } else if (upgraded && history[0]) {
      history = [
        { ...entry, at: history[0].at },
        ...history.slice(1).filter((h) => h.key !== track.key),
      ];
    }
    this.snap = { ...this.snap, track, changedAt, history };
    if (isNew || upgraded) this.persist();
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
