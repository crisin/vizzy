// Which preset the auto-switch picks next.
//
// Without tags every candidate is equally likely, as before. With energy and
// section tags the draw is weighted towards presets that fit what the music
// is doing right now: the smoothed level (live.level, adaptive per track) and
// the last section boundary (energy jumped up → "drop", fell → "break"; the
// first half minute after silence → "intro"). Recently played presets are
// pushed down so a small tag pool doesn't ping-pong.

import { live, type EnergyLevel } from "./live";
import { ENERGY_TAGS, NEVER_AUTO, tagStore } from "./tags";

export type TagMode = 0 | 1 | 2; // aus | sanft | streng

/** Learned fit for the running song / artist / playlist (see
 *  `regie/contextRatings.ts`); 1 = nothing known. Registered from outside so
 *  this module stays free of the now-playing machinery. */
let contextWeight: (key: string) => number = () => 1;
export function setContextWeight(fn: (key: string) => number) {
  contextWeight = fn;
}

const recent: string[] = [];
const RECENT_MAX = 8;

export function notePlayed(key: string) {
  const i = recent.indexOf(key);
  if (i >= 0) recent.splice(i, 1);
  recent.unshift(key);
  if (recent.length > RECENT_MAX) recent.pop();
}

function energyOf(key: string): EnergyLevel | null {
  const tags = tagStore.get(key);
  for (let i = 0; i < ENERGY_TAGS.length; i++) {
    if (tags.includes(ENERGY_TAGS[i])) return i as EnergyLevel;
  }
  return null;
}

/** The section tag the music currently asks for, if any. */
export function wantedSection(): string | null {
  if (live.trackStartAt > 0 && live.trackAge() < 30) return "intro";
  if (live.sinceSection() < 6) {
    if (live.lastMove === "up") return "drop";
    if (live.lastMove === "down") return live.level === 0 ? "outro" : "break";
  }
  // late in a phrase with the level climbing: something is building
  if (live.gridConf >= 0.5 && live.phrasePhase > 0.6 && live.short > live.long * 1.08) {
    return "build";
  }
  return null;
}

export function pickAuto(
  candidates: string[],
  current: string,
  mode: TagMode,
): string {
  const pool = candidates.filter((k) => k !== current && !tagStore.has(k, NEVER_AUTO));
  if (pool.length === 0) return candidates[0] ?? current;
  if (mode === 0) {
    // plain random — unless something was learned for this song, then that
    // alone weights the draw
    const cw = pool.map(contextWeight);
    if (cw.every((w) => w === 1)) {
      const k = pool[Math.floor(Math.random() * pool.length)];
      live.lastPick = `auto: zufällig → ${k}`;
      return k;
    }
    const total = cw.reduce((a, b) => a + b, 0);
    let x = Math.random() * total;
    let i = 0;
    for (; i < pool.length - 1; i++) {
      x -= cw[i];
      if (x <= 0) break;
    }
    live.lastPick = `auto: gelernt → ${pool[i]} (ctx×${cw[i].toFixed(2)})`;
    return pool[i];
  }

  const level = live.level;
  const section = wantedSection();
  const weights = pool.map((k) => {
    const e = energyOf(k);
    let w: number;
    if (e === null) w = mode === 2 ? 0 : 0.5;
    else {
      const d = Math.abs(e - level);
      w = d === 0 ? 1 : d === 1 ? (mode === 2 ? 0 : 0.3) : mode === 2 ? 0 : 0.05;
    }
    if (section && tagStore.has(k, section)) w *= mode === 2 ? 4 : 3;
    const r = recent.indexOf(k);
    if (r >= 0) w *= 0.1 + (0.9 * r) / RECENT_MAX;
    // + / - while listening: each step is a factor of 1.5
    w *= Math.pow(1.5, tagStore.rating(k));
    // + / - for this song, artist, playlist
    w *= contextWeight(k);
    return w;
  });
  let total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    // strict mode found nothing fitting: fall back to everything
    weights.fill(1);
    total = weights.length;
  }
  let x = Math.random() * total;
  let i = 0;
  for (; i < pool.length - 1; i++) {
    x -= weights[i];
    if (x <= 0) break;
  }
  const k = pool[i];
  const why = [
    `energie ${ENERGY_TAGS[level]}`,
    section ? `abschnitt ${section}` : "",
    contextWeight(k) !== 1 ? `ctx×${contextWeight(k).toFixed(2)}` : "",
    `w=${weights[i].toFixed(2)}`,
  ]
    .filter(Boolean)
    .join(", ");
  live.lastPick = `auto: ${k} (${why})`;
  return k;
}
