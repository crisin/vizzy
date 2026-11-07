// Spotify connection state (the client lives in Rust: `src-tauri/src/spotify.rs`).
// Tokens never come here — only status and what is playing.

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const inTauri = "__TAURI_INTERNALS__" in window;

export type SpotifyContext = { kind: string; uri: string; name: string | null };

export type SpotifyNow = {
  trackId: string;
  uri: string;
  title: string;
  artists: string[];
  album: string;
  durationMs: number;
  progressMs: number;
  isPlaying: boolean;
  sampledAt: number;
  context: SpotifyContext | null;
};

export type SpotifyStatus = {
  clientId: string;
  connected: boolean;
  connecting: boolean;
  user: string | null;
  redirectUri: string;
  error: string | null;
};

const EMPTY: SpotifyStatus = {
  clientId: "",
  connected: false,
  connecting: false,
  user: null,
  redirectUri: "http://127.0.0.1:43821/callback",
  error: null,
};

class SpotifyStore {
  private status: SpotifyStatus = EMPTY;
  private listeners = new Set<() => void>();

  constructor() {
    if (!inTauri) return;
    void listen<SpotifyStatus>("spotify-status", (e) => this.set(e.payload));
    void invoke<SpotifyStatus>("spotify_status").then((s) => this.set(s)).catch(() => {});
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = () => this.status;

  private set(s: SpotifyStatus) {
    this.status = s;
    for (const fn of this.listeners) fn();
  }

  async setClientId(id: string) {
    if (!inTauri) return;
    this.set(await invoke<SpotifyStatus>("spotify_set_client_id", { clientId: id }));
  }

  async connect() {
    if (!inTauri) return;
    try {
      this.set(await invoke<SpotifyStatus>("spotify_connect"));
    } catch (e) {
      this.set({ ...this.status, connecting: false, error: String(e) });
    }
  }

  cancel() {
    if (inTauri) void invoke("spotify_cancel_connect").catch(() => {});
  }

  async disconnect() {
    if (!inTauri) return;
    this.set(await invoke<SpotifyStatus>("spotify_disconnect"));
  }

  /** The media session saw a new song: poll Spotify right away. */
  pollNow() {
    if (inTauri && this.status.connected) void invoke("spotify_poll_now").catch(() => {});
  }
}

export const spotify = new SpotifyStore();

export function useSpotifyStatus(): SpotifyStatus {
  return useSyncExternalStore(spotify.subscribe, spotify.getSnapshot);
}
