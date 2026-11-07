// Pools and rules ("Regie"): what plays for which song / artist / playlist.
//
//   pools.json  — curated preset lists the auto-switch rotates through
//   rules.json  — ordered rule list (first match wins) + the global switch
//
// Same storage pattern as combos.ts: app data dir in Tauri, localStorage
// mirror (and the only store in the browser preview).

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

const inTauri = "__TAURI_INTERNALS__" in window;

export type PoolPick = "smart" | "shuffle" | "order";

export type Pool = {
  id: string;
  name: string;
  /** preset keys; `combo:<name>` for a saved combo */
  entries: string[];
  pick: PoolPick;
  created: number;
};

export type RuleMatch =
  /** `keys`: every key this song is known under (spotify id and/or smtc key) */
  | { kind: "song"; keys: string[]; label: string }
  | { kind: "artist"; name: string }
  /** a Spotify context: playlist, album, Liked Songs … */
  | { kind: "context"; uri: string; ctxKind: string; name: string };

export type Hold = "song" | "start";

export type RuleTarget =
  | { kind: "preset"; key: string; hold: Hold }
  | { kind: "combo"; name: string; hold: Hold }
  | { kind: "pool"; poolId: string };

export type Rule = {
  id: string;
  enabled: boolean;
  match: RuleMatch;
  target: RuleTarget;
  created: number;
};

type RulesFile = { version: 1; enabled: boolean; rules: Rule[] };
type PoolsFile = { version: 1; pools: Pool[] };

export type RegieSnapshot = { enabled: boolean; rules: Rule[]; pools: Pool[] };

export const COMBO_PREFIX = "combo:";

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** One JSON document in the data dir with a localStorage mirror. */
function fileDoc<T>(file: string, ls: string, fallback: T, onLoad: (v: T) => void) {
  let initial = fallback;
  try {
    const s = localStorage.getItem(ls);
    if (s) initial = { ...fallback, ...JSON.parse(s) };
  } catch {
    // ignore
  }
  if (inTauri) {
    invoke<string | null>("data_read", { name: file })
      .then((s) => {
        if (s) onLoad({ ...fallback, ...JSON.parse(s) });
      })
      .catch(() => {});
  }
  return {
    initial,
    save(v: T) {
      const json = JSON.stringify(v, null, 1);
      try {
        localStorage.setItem(ls, json);
      } catch {
        // ignore
      }
      if (inTauri) void invoke("data_write", { name: file, contents: json }).catch(() => {});
    },
  };
}

class RegieStore {
  private snap: RegieSnapshot;
  private listeners = new Set<() => void>();
  private rulesDoc;
  private poolsDoc;

  constructor() {
    this.rulesDoc = fileDoc<RulesFile>(
      "rules.json",
      "vizzy.rules.v1",
      { version: 1, enabled: true, rules: [] },
      (v) => this.set({ enabled: v.enabled, rules: v.rules }, false),
    );
    this.poolsDoc = fileDoc<PoolsFile>("pools.json", "vizzy.pools.v1", { version: 1, pools: [] }, (v) =>
      this.set({ pools: v.pools }, false),
    );
    this.snap = {
      enabled: this.rulesDoc.initial.enabled,
      rules: this.rulesDoc.initial.rules,
      pools: this.poolsDoc.initial.pools,
    };
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = () => this.snap;

  private set(patch: Partial<RegieSnapshot>, save = true) {
    const prev = this.snap;
    this.snap = { ...prev, ...patch };
    if (save) {
      if (patch.rules || patch.enabled !== undefined)
        this.rulesDoc.save({ version: 1, enabled: this.snap.enabled, rules: this.snap.rules });
      if (patch.pools) this.poolsDoc.save({ version: 1, pools: this.snap.pools });
    }
    for (const fn of this.listeners) fn();
  }

  // ---- rules

  setEnabled(enabled: boolean) {
    this.set({ enabled });
  }

  /** Adds a rule, or replaces the target of an existing rule with the same match. */
  upsertRule(match: RuleMatch, target: RuleTarget): Rule {
    const existing = this.snap.rules.find((r) => sameMatch(r.match, match));
    if (existing) {
      const updated = { ...existing, target, enabled: true };
      this.set({ rules: this.snap.rules.map((r) => (r.id === existing.id ? updated : r)) });
      return updated;
    }
    const rule: Rule = { id: newId("r"), enabled: true, match, target, created: Date.now() };
    // a single song is the most specific thing there is — it goes first;
    // broader rules go to the end, the user sorts from there
    const rules = match.kind === "song" ? [rule, ...this.snap.rules] : [...this.snap.rules, rule];
    this.set({ rules });
    return rule;
  }

  updateRule(id: string, patch: Partial<Rule>) {
    this.set({ rules: this.snap.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
  }

  removeRule(id: string) {
    this.set({ rules: this.snap.rules.filter((r) => r.id !== id) });
  }

  moveRule(id: string, to: number) {
    const rules = [...this.snap.rules];
    const from = rules.findIndex((r) => r.id === id);
    if (from < 0) return;
    const [r] = rules.splice(from, 1);
    rules.splice(Math.max(0, Math.min(rules.length, to)), 0, r);
    this.set({ rules });
  }

  // ---- pools

  createPool(name: string, entries: string[] = []): Pool {
    const pool: Pool = { id: newId("p"), name, entries, pick: "smart", created: Date.now() };
    this.set({ pools: [...this.snap.pools, pool] });
    return pool;
  }

  updatePool(id: string, patch: Partial<Pool>) {
    this.set({ pools: this.snap.pools.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
  }

  addToPool(id: string, key: string) {
    const p = this.snap.pools.find((x) => x.id === id);
    if (!p || p.entries.includes(key)) return;
    this.updatePool(id, { entries: [...p.entries, key] });
  }

  removeFromPool(id: string, key: string) {
    const p = this.snap.pools.find((x) => x.id === id);
    if (p) this.updatePool(id, { entries: p.entries.filter((k) => k !== key) });
  }

  /** Deletes the pool and every rule pointing at it. */
  removePool(id: string) {
    this.set({
      pools: this.snap.pools.filter((p) => p.id !== id),
      rules: this.snap.rules.filter((r) => !(r.target.kind === "pool" && r.target.poolId === id)),
    });
  }
}

export function sameMatch(a: RuleMatch, b: RuleMatch): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "song" && b.kind === "song") return a.keys.some((k) => b.keys.includes(k));
  if (a.kind === "artist" && b.kind === "artist") return a.name.toLowerCase() === b.name.toLowerCase();
  if (a.kind === "context" && b.kind === "context") return a.uri === b.uri;
  return false;
}

export const regie = new RegieStore();

export function useRegie(): RegieSnapshot {
  return useSyncExternalStore(regie.subscribe, regie.getSnapshot);
}
