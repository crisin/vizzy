// Debug entries from the frontend for the transcript log (lyrics_log.rs):
// what Lyrics Helper delivered, what the synced lyrics did with a heard
// line, which line went on screen, the refrain and voice events. The Rust
// worker writes them into the same lyrics-log/YYYY-MM-DD.jsonl as its own,
// so one file tells the whole story of a song.
//
// Only at the debug level (`log: 2`); the lyrics store switches it.

import { invoke } from "@tauri-apps/api/core";
import { lyricEvents, type LyricEvent } from "./events";

const inTauri = "__TAURI_INTERNALS__" in window;

export const debugLog = {
  /** set by the lyrics store: live lyrics on and the log at debug level */
  on: false,

  note(kind: string, data: Record<string, unknown> = {}) {
    if (!this.on || !inTauri) return;
    void invoke("lyrics_note", { entry: { kind, ...data } }).catch(() => {});
  },
};

// `line` is the worker's own entry (heard) or `show` (synced)
for (const ev of ["refrain", "refrainEnd", "voiceOn", "voiceOff"] satisfies LyricEvent[]) {
  lyricEvents.on(ev, (detail) => debugLog.note("event", detail ? { event: ev, text: detail } : { event: ev }));
}
