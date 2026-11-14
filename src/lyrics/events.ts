// What happens in the singing, as events (PLAN-stimme.md, S2):
//   line      — a committed lyric line
//   refrain   — the first repeated line of a block (the chorus comes back)
//   refrainEnd— two fresh lines in a row, or a while without any line
//   voiceOn   — singing starts after an instrumental stretch
//   voiceOff  — no singing for a while: an instrumental starts
// The line events come from the lyrics worker (repeat flags, lyrics.rs);
// the voice events from the analyzer's voice gate (voice.rs) via `live`.

import { live } from "../milkdrop/live";
import { params } from "../params";

export type LyricEvent = "line" | "refrain" | "refrainEnd" | "voiceOn" | "voiceOff";
type Fn = (detail: string) => void;

/** a chorus block that went quiet for this long has ended */
const REFRAIN_IDLE_MS = 12_000;

class LyricEvents {
  private fns = new Map<LyricEvent, Set<Fn>>();
  refrainActive = false;
  private refrainLastLineAt = 0;
  private freshInRow = 0;
  // voice watch
  private voiceOnFor = 0;
  private voiceOffFor = 0;
  private singing = false;

  on(ev: LyricEvent, fn: Fn): () => void {
    let set = this.fns.get(ev);
    if (!set) this.fns.set(ev, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  emit(ev: LyricEvent, detail = "") {
    for (const fn of this.fns.get(ev) ?? []) fn(detail);
  }

  /** From the lyrics store, once per new committed line. */
  line(text: string, repeat: boolean) {
    this.emit("line", text);
    const now = performance.now();
    if (repeat) {
      this.freshInRow = 0;
      this.refrainLastLineAt = now;
      if (!this.refrainActive) {
        this.refrainActive = true;
        this.emit("refrain", text);
      }
    } else if (this.refrainActive && ++this.freshInRow >= 2) {
      this.endRefrain();
    }
  }

  /** A new song: whatever block was running is over. */
  reset() {
    if (this.refrainActive) this.endRefrain();
    this.freshInRow = 0;
  }

  private endRefrain() {
    this.refrainActive = false;
    this.emit("refrainEnd");
  }

  /** Every frame from the render loop. */
  tick(dt: number) {
    const now = performance.now();
    if (this.refrainActive && now - this.refrainLastLineAt > REFRAIN_IDLE_MS) this.endRefrain();

    const quiet = params.get("react", "instrumental");
    if (live.voiceGate) {
      this.voiceOnFor += dt;
      // singing again after a stretch without: "voice on" — a short
      // confirmation so a single syllable in an instrumental does not count
      if (!this.singing && this.voiceOffFor >= quiet && this.voiceOnFor > 0.4) {
        this.singing = true;
        this.voiceOffFor = 0;
        this.emit("voiceOn");
      } else if (this.voiceOnFor > 0.4) {
        this.singing = true;
        this.voiceOffFor = 0;
      }
    } else {
      this.voiceOnFor = 0;
      this.voiceOffFor += dt;
      if (this.singing && this.voiceOffFor >= quiet) {
        this.singing = false;
        this.emit("voiceOff");
      }
    }
  }
}

export const lyricEvents = new LyricEvents();
