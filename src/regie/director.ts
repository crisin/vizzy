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
import { pickAuto, setContextWeight, type TagMode } from "../milkdrop/autoswitch";
import { live } from "../milkdrop/live";
import { comboStore, type Combo } from "../milkdrop/combos";
import { params } from "../params";
import { nowPlaying, type Track } from "./nowPlaying";
import { artistsOf } from "./artists";
import { LEARNED_START, contextRatings } from "./contextRatings";
export { artistsOf, splitArtists } from "./artists";
import { queue } from "./queue";
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
  /** a queue entry is on screen — once the queue runs dry the rule comes back */
  private queueRan = false;
  /** song (baseKey) the learned start was already decided for */
  private learnedFor = "";
  private songStartedAt = 0;
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
    if (songChanged) {
      this.lastEntry = "";
      this.songStartedAt = performance.now();
    }
    this.setActive(next);
    const sig = next ? `${next.rule.id}|${JSON.stringify(next.rule.target)}` : "";
    // apply on a new song, or when a different/edited rule takes over
    // mid-song (Spotify's playlist arriving after the media session)
    const due = songChanged || (next !== null && sig !== this.appliedSig);
    this.appliedSig = sig;
    if (!due) {
      // no rule: Spotify's id / playlist may arrive a moment after the song
      // started and reveal a learned favourite — still early enough to use
      if (!next && track && !this.queueRan) this.learnedStart(track);
      return;
    }
    // the queue outranks every rule — a new song takes its next entry
    if (songChanged && queue.length > 0) {
      this.playQueued();
      return;
    }
    // mid-song rule change while a queue entry shows: let it finish its slot
    if (!songChanged && this.queueRan) return;
    if (next) this.apply(next.rule);
    else if (track) this.learnedStart(track);
  }

  /**
   * Without a rule: a song with a clear learned favourite (+ given while it
   * played, here or under its artist / playlist) starts with it. Once per
   * song, only within its first seconds.
   */
  private learnedStart(track: Track) {
    if (!this.host || !contextRatings.enabled) return;
    if (this.learnedFor === track.baseKey) return;
    if (performance.now() - this.songStartedAt > 12_000) return;
    const ok = this.host.playable();
    const best = contextRatings
      .known(track)
      .find((k) => k.score >= LEARNED_START && ok.has(k.preset));
    if (!best) return;
    this.learnedFor = track.baseKey;
    if (this.playEntry(best.preset)) live.lastPick = `gelernt: ${best.preset} (score ${best.score.toFixed(1)})`;
  }

  /** Puts a preset key or `combo:<name>` on screen. */
  private playEntry(ref: string): boolean {
    const h = this.host;
    if (!h) return false;
    if (ref.startsWith(COMBO_PREFIX)) {
      const c = comboStore.getSnapshot().find((x) => x.name === ref.slice(COMBO_PREFIX.length));
      if (!c) return false;
      h.applyCombo(c);
    } else {
      if (!h.playable().has(ref)) return false;
      h.applyPreset(ref);
    }
    this.lastEntry = ref;
    return true;
  }

  /** Next playable queue entry; unplayable ones (deleted, quarantined) are dropped. */
  private playQueued(): boolean {
    for (let it = queue.shift(); it; it = queue.shift()) {
      if (this.playEntry(it.ref)) {
        this.queueRan = true;
        live.lastPick = `queue: ${it.ref}`;
        return true;
      }
    }
    return false;
  }

  /** "N": the next queue entry right now. */
  playNextQueued(): boolean {
    return queue.length > 0 && this.playQueued();
  }

  private apply(rule: Rule) {
    if (!this.host) return;
    this.queueRan = false;
    const t = rule.target;
    if (t.kind === "preset") {
      this.playEntry(t.key);
    } else if (t.kind === "combo") {
      this.playEntry(COMBO_PREFIX + t.name);
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
    this.queueRan = false;
    if (pool.pick === "order") {
      const pos = fresh ? 0 : ((this.orderPos.get(pool.id) ?? -1) + 1) % list.length;
      this.orderPos.set(pool.id, pos);
      next = list[pos];
    } else {
      const mode = pool.pick === "shuffle" ? 0 : ((params.get("milkdrop", "tagMode") | 0) as TagMode);
      next = pickAuto(list, current, mode);
    }
    this.playEntry(next);
    live.lastPick = `pool ${pool.name}: ${next}`;
  }

  /**
   * Asked by the auto-switch before it picks. `true` = handled (held or
   * picked from a pool), `false` = do the usual thing. A trapping preset
   * or a "-" rating ("skip") always gets out of a hold.
   */
  override(reason: "auto" | "trap" | "skip"): boolean {
    if (queue.length > 0 && this.playQueued()) return true;
    const a = this.active;
    if (this.queueRan) {
      // queue ran dry: back to what the rule wants
      this.queueRan = false;
      if (a) {
        this.apply(a.rule);
        return true;
      }
    }
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

setContextWeight((key) => contextRatings.weight(nowPlaying.getSnapshot().track, key));

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
