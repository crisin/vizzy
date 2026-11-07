// The director decides what plays, between the music (now playing) and the
// auto-switch. Order of authority (PLAN-playlists.md):
//   (queue — phase 4) > song choreo (phase 6) > first matching rule > auto-switch
//
// Two touch points with App:
//  - on a song change (or when Spotify adds the playlist a moment later, or
//    a rule is edited) it applies the matching rule's target via `host`;
//  - the auto-switch asks `override()` before it picks: hold the current
//    picture, pick from a pool, or carry on as usual.
// Without a matching rule nothing changes compared to before.

import { useSyncExternalStore } from "react";
import { pickAuto, type TagMode } from "../milkdrop/autoswitch";
import { live } from "../milkdrop/live";
import { comboStore, type Combo } from "../milkdrop/combos";
import { params } from "../params";
import { nowPlaying, type Track } from "./nowPlaying";
import { COMBO_PREFIX, regie, type Pool, type Rule, type RuleMatch } from "./regieStore";

export type DirectorHost = {
  applyPreset: (key: string) => void;
  applyCombo: (combo: Combo) => void;
  /** preset keys allowed to play (exists, not quarantined) */
  playable: () => Set<string>;
  currentKey: () => string;
  label: (key: string) => string;
};

export type Active = { rule: Rule; index: number } | null;

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").trim();

/** Artist names as written: "Dr. Dre, Snoop Dogg" → ["Dr. Dre", "Snoop Dogg"] */
export function splitArtists(artist: string): string[] {
  return artist
    .split(/\s*(?:,|;|&|\bfeat\.?|\bft\.?|\bx\b)\s*/i)
    .map((a) => a.trim())
    .filter(Boolean);
}

/** All artist names in a media-session / Spotify artist string, normalised. */
export function artistsOf(artist: string): string[] {
  return splitArtists(artist).map(norm);
}

export function matches(m: RuleMatch, t: Track): boolean {
  switch (m.kind) {
    case "song":
      return m.keys.includes(t.key) || m.keys.includes(t.baseKey);
    case "artist":
      return artistsOf(t.artist).includes(norm(m.name));
    case "context":
      return t.context?.uri === m.uri;
  }
}

export function firstMatch(rules: Rule[], t: Track | null): Active {
  if (!t) return null;
  const index = rules.findIndex((r) => r.enabled && matches(r.match, t));
  return index < 0 ? null : { rule: rules[index], index };
}

class Director {
  private host: DirectorHost | null = null;
  private active: Active = null;
  private lastBase = "";
  /** what was last applied: rule id + target, so edits re-apply */
  private appliedSig = "";
  private orderPos = new Map<string, number>();
  /** the pool entry that is on screen (may be a combo) */
  private lastEntry = "";
  private listeners = new Set<() => void>();

  constructor() {
    nowPlaying.subscribe(() => this.evaluate());
    regie.subscribe(() => this.evaluate());
  }

  attach(host: DirectorHost): () => void {
    this.host = host;
    this.evaluate();
    return () => {
      if (this.host === host) this.host = null;
    };
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = () => this.active;

  private setActive(a: Active) {
    if (a?.rule.id === this.active?.rule.id && a?.rule === this.active?.rule && a?.index === this.active?.index) return;
    this.active = a;
    for (const fn of this.listeners) fn();
  }

  private evaluate() {
    const { enabled, rules } = regie.getSnapshot();
    const { track } = nowPlaying.getSnapshot();
    const next = enabled ? firstMatch(rules, track) : null;
    const songChanged = !!track && track.baseKey !== this.lastBase;
    if (track) this.lastBase = track.baseKey;
    if (songChanged) this.lastEntry = "";
    this.setActive(next);
    if (!next) {
      this.appliedSig = "";
      return;
    }
    const sig = `${next.rule.id}|${JSON.stringify(next.rule.target)}`;
    // apply on a new song, or when a different/edited rule takes over
    // mid-song (Spotify's playlist arriving after the media session)
    if (!songChanged && sig === this.appliedSig) return;
    this.appliedSig = sig;
    this.apply(next.rule);
  }

  private apply(rule: Rule) {
    const h = this.host;
    if (!h) return;
    const t = rule.target;
    if (t.kind === "preset") {
      if (h.playable().has(t.key)) h.applyPreset(t.key);
      this.lastEntry = t.key;
    } else if (t.kind === "combo") {
      const c = comboStore.getSnapshot().find((x) => x.name === t.name);
      if (c) h.applyCombo(c);
      this.lastEntry = COMBO_PREFIX + t.name;
    } else {
      const pool = regie.getSnapshot().pools.find((p) => p.id === t.poolId);
      if (pool) this.playFromPool(pool, true);
    }
    live.lastPick = `regel ${this.describeTarget(rule)}`;
  }

  /** Entries of a pool that can actually play right now. */
  private candidates(pool: Pool): string[] {
    const h = this.host;
    if (!h) return [];
    const ok = h.playable();
    const combos = new Set(comboStore.getSnapshot().map((c) => c.name));
    return pool.entries.filter((e) =>
      e.startsWith(COMBO_PREFIX) ? combos.has(e.slice(COMBO_PREFIX.length)) : ok.has(e),
    );
  }

  private playFromPool(pool: Pool, fresh: boolean) {
    const h = this.host;
    if (!h) return;
    const list = this.candidates(pool);
    if (list.length === 0) return;
    const current = this.lastEntry || h.currentKey();
    let next: string;
    if (pool.pick === "order") {
      const pos = fresh ? 0 : ((this.orderPos.get(pool.id) ?? -1) + 1) % list.length;
      this.orderPos.set(pool.id, pos);
      next = list[pos];
    } else {
      const mode = pool.pick === "shuffle" ? 0 : ((params.get("milkdrop", "tagMode") | 0) as TagMode);
      next = pickAuto(list, current, mode);
    }
    this.lastEntry = next;
    if (next.startsWith(COMBO_PREFIX)) {
      const c = comboStore.getSnapshot().find((x) => x.name === next.slice(COMBO_PREFIX.length));
      if (c) h.applyCombo(c);
    } else {
      h.applyPreset(next);
    }
    live.lastPick = `pool ${pool.name}: ${next}`;
  }

  /**
   * Asked by the auto-switch before it picks. `true` = handled (held or
   * picked from a pool), `false` = do the usual thing. A trapping preset
   * or a "-" rating ("skip") always gets out of a hold.
   */
  override(reason: "auto" | "trap" | "skip"): boolean {
    const a = this.active;
    if (!a) return false;
    const t = a.rule.target;
    if (t.kind === "pool") {
      const pool = regie.getSnapshot().pools.find((p) => p.id === t.poolId);
      if (!pool || this.candidates(pool).length < 2) return reason === "auto";
      this.playFromPool(pool, false);
      return true;
    }
    if (t.hold === "song" && reason === "auto") {
      live.lastPick = `regel hält: ${this.describeTarget(a.rule)}`;
      return true;
    }
    return false;
  }

  describeTarget(rule: Rule): string {
    const t = rule.target;
    if (t.kind === "preset") return this.host?.label(t.key) ?? t.key;
    if (t.kind === "combo") return `Kombi ${t.name}`;
    return `Pool ${regie.getSnapshot().pools.find((p) => p.id === t.poolId)?.name ?? "?"}`;
  }
}

export const director = new Director();

export function useActiveRule(): Active {
  return useSyncExternalStore(director.subscribe, director.getSnapshot);
}

export function describeMatch(m: RuleMatch): string {
  switch (m.kind) {
    case "song":
      return m.label;
    case "artist":
      return m.name;
    case "context":
      return m.name;
  }
}

export const MATCH_ICON: Record<RuleMatch["kind"], string> = { song: "♪", artist: "☺", context: "▤" };
export const MATCH_KIND_LABEL: Record<RuleMatch["kind"], string> = {
  song: "Song",
  artist: "Artist",
  context: "Spotify",
};

if (import.meta.env.DEV) {
  // console / preview testing: __vizzyDirector.override("auto")
  (window as unknown as Record<string, unknown>).__vizzyDirector = director;
}
