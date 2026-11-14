// Synced lyrics, the pure part: which line is due at a song time, and how
// a line Whisper just heard sets the clock (PLAN-stimme.md, S3). No DOM,
// no Tauri — `node src/lyrics/syncCore.test.ts` runs the checks.

export type TimedLine = { text: string; startMs: number };

/** lower-case words, punctuation dropped (same idea as words() in lyrics.rs) */
export function words(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .split(" ")
    .filter(Boolean);
}

/** 2·LCS / (|a| + |b|) over words: 1 = same line, ~0.7 = heard a bit differently */
export function similarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.length || !y.length) return 0;
  const dp = new Array<number>(y.length + 1).fill(0);
  for (let i = 0; i < x.length; i++) {
    let prev = 0;
    for (let j = 0; j < y.length; j++) {
      const tmp = dp[j + 1];
      dp[j + 1] = x[i] === y[j] ? prev + 1 : Math.max(dp[j + 1], dp[j]);
      prev = tmp;
    }
  }
  return (2 * dp[y.length]) / (x.length + y.length);
}

/** Index of the line sung at `songMs` (-1 before the first). */
export function lineAt(lines: TimedLine[], songMs: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].startMs <= songMs) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** Whisper's line, located in the synced lyrics: the best match within
 *  `windowMs` of where the clock thinks we are (choruses repeat, so the
 *  nearest of equal matches wins). Whisper may merge or split lines, so a
 *  line is also compared joined with its successor. */
export function locate(
  lines: TimedLine[],
  heard: string,
  expectedMs: number | null,
  windowMs: number,
  minSim = 0.6,
): { index: number; sim: number } | null {
  if (words(heard).length < 2) return null;
  let best: { index: number; sim: number; dist: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const dist = expectedMs === null ? 0 : Math.abs(lines[i].startMs - expectedMs);
    if (expectedMs !== null && dist > windowMs) continue;
    const joined = i + 1 < lines.length ? `${lines[i].text} ${lines[i + 1].text}` : lines[i].text;
    const sim = Math.max(similarity(heard, lines[i].text), similarity(heard, joined) * 0.95);
    if (sim < minSim) continue;
    // a clearly better match wins; among equals the nearer one
    if (!best || sim > best.sim + 0.05 || (Math.abs(sim - best.sim) <= 0.05 && dist < best.dist)) {
      best = { index: i, sim, dist };
    }
  }
  return best && { index: best.index, sim: best.sim };
}

/**
 * The clock: song time = position + offset. The position comes from the
 * media session when there is one, else from our own running clock that
 * the last match started. Offsets from matches are kept as a short
 * history; the median is used, and a jump only after two matches agree.
 */
export class SyncClock {
  offsets: number[] = [];
  offsetMs = 0;
  /** media session position missing: song time at `anchorReal` */
  anchorSong: number | null = null;
  anchorReal = 0;
  matched = 0;
  lastMatchReal = -1e12;
  private pending: number | null = null;

  reset() {
    this.offsets = [];
    this.offsetMs = 0;
    this.anchorSong = null;
    this.matched = 0;
    this.pending = null;
    this.lastMatchReal = -1e12;
  }

  /** song time now, or null without position and without a match */
  songMs(positionMs: number | null, nowReal: number): number | null {
    if (positionMs !== null) return positionMs + this.offsetMs;
    if (this.anchorSong === null) return null;
    return this.anchorSong + (nowReal - this.anchorReal);
  }

  /**
   * A line that started `agoMs` ago matched synced line `lineStartMs`.
   * `positionMs` is the media position now (null without one).
   */
  match(lineStartMs: number, agoMs: number, positionMs: number | null, nowReal: number) {
    this.matched++;
    this.lastMatchReal = nowReal;
    if (positionMs === null) {
      this.anchorSong = lineStartMs + agoMs;
      this.anchorReal = nowReal;
      return;
    }
    const measured = lineStartMs - (positionMs - agoMs);
    const median = this.median();
    if (this.offsets.length >= 2 && Math.abs(measured - median) > 3000) {
      // a jump (seek, a different version): only when the next agrees
      if (this.pending !== null && Math.abs(measured - this.pending) < 1500) {
        this.offsets = [this.pending, measured];
        this.pending = null;
      } else {
        this.pending = measured;
        return;
      }
    } else {
      this.pending = null;
      this.offsets.push(measured);
      if (this.offsets.length > 5) this.offsets.shift();
    }
    this.offsetMs = this.median();
  }

  private median(): number {
    if (!this.offsets.length) return 0;
    const s = [...this.offsets].sort((a, b) => a - b);
    return s[s.length >> 1];
  }
}
