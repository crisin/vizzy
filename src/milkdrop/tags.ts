// Preset tags — like favourites, but named and as many as you like.
//
// Three sources, later ones win per preset:
//   1. code: `TAG_SEEDS` (tagSeeds.ts) and `tags` on curated presets
//   2. the user's own file, `tags.json` in the app data directory
// A preset that appears in the user map at all — even with an empty list —
// is fully owned by the user from then on, so removing a seeded tag sticks.
//
// Some tags carry meaning for the auto-switch (energy, song section,
// never-auto); everything else is a free label.

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TAG_SEEDS } from "./tagSeeds";
import { CURATED, CURATED_PREFIX } from "../curated";

const inTauri = "__TAURI_INTERNALS__" in window;

export const ENERGY_TAGS = ["ruhig", "mittel", "hoch"] as const;
export const SECTION_TAGS = ["intro", "build", "drop", "break", "outro"] as const;
export const NEVER_AUTO = "nie-auto";
export const RESERVED_TAGS: string[] = [...ENERGY_TAGS, ...SECTION_TAGS, NEVER_AUTO];

export type TagDef = { name: string; color: string };

const RESERVED_COLORS: Record<string, string> = {
  ruhig: "#60a5fa",
  mittel: "#a78bfa",
  hoch: "#f472b6",
  intro: "#34d399",
  build: "#fbbf24",
  drop: "#f87171",
  break: "#22d3ee",
  outro: "#94a3b8",
  "nie-auto": "#64748b",
};
const PALETTE = ["#38bdf8", "#4ade80", "#facc15", "#fb923c", "#c084fc", "#2dd4bf", "#e879f9", "#a3e635"];

type FileShape = {
  version: 1;
  /** user-defined tags in display order (reserved ones are implicit) */
  tags: TagDef[];
  /** per preset key; presence means "the user owns this preset's tags" */
  presets: Record<string, string[]>;
};

const LS_KEY = "vizzy.tags.v1";
const FILE = "tags.json";

export function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 32);
}

function colorFor(name: string, index: number): string {
  return RESERVED_COLORS[name] ?? PALETTE[index % PALETTE.length];
}

class TagStore {
  private data: FileShape = { version: 1, tags: [], presets: {} };
  private listeners = new Set<() => void>();
  private version = 0;
  private saveTimer = 0;
  private codeTags = new Map<string, string[]>();

  constructor() {
    for (const [k, v] of Object.entries(TAG_SEEDS)) this.codeTags.set(k, v);
    for (const p of CURATED) {
      if (p.tags?.length) this.codeTags.set(`${CURATED_PREFIX}${p.name}`, p.tags);
    }
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) this.data = this.sanitize(JSON.parse(raw));
    } catch {
      // ignore — start empty
    }
    if (inTauri) {
      invoke<string | null>("data_read", { name: FILE })
        .then((s) => {
          if (s == null) {
            // first run with file storage: the local copy becomes the file
            this.scheduleSave();
            return;
          }
          this.data = this.sanitize(JSON.parse(s));
          this.emit(false);
        })
        .catch((e) => console.error("[tags] read failed", e));
    }
  }

  private sanitize(x: unknown): FileShape {
    const d = (x ?? {}) as Partial<FileShape>;
    const tags = Array.isArray(d.tags)
      ? d.tags.filter((t) => t && typeof t.name === "string")
      : [];
    const presets: Record<string, string[]> = {};
    if (d.presets && typeof d.presets === "object") {
      for (const [k, v] of Object.entries(d.presets)) {
        if (Array.isArray(v)) presets[k] = v.filter((t) => typeof t === "string");
      }
    }
    return { version: 1, tags, presets };
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getVersion = () => this.version;

  private emit(save = true) {
    this.version++;
    for (const fn of this.listeners) fn();
    if (save) this.scheduleSave();
  }

  private scheduleSave() {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      const json = JSON.stringify(this.data, null, 1);
      try {
        localStorage.setItem(LS_KEY, json);
      } catch {
        // storage unavailable
      }
      if (inTauri) {
        invoke("data_write", { name: FILE, contents: json }).catch((e) =>
          console.error("[tags] write failed", e),
        );
      }
    }, 400);
  }

  /** All known tags: reserved first, then user tags, then any tag that only
   *  appears in code seeds. */
  allTags(): TagDef[] {
    const out: TagDef[] = RESERVED_TAGS.map((n, i) => ({ name: n, color: colorFor(n, i) }));
    const seen = new Set(RESERVED_TAGS);
    for (const t of this.data.tags) {
      if (!seen.has(t.name)) {
        out.push(t);
        seen.add(t.name);
      }
    }
    const extra = new Set<string>();
    for (const list of [...this.codeTags.values(), ...Object.values(this.data.presets)]) {
      for (const t of list) if (!seen.has(t)) extra.add(t);
    }
    let i = out.length;
    for (const n of [...extra].sort()) out.push({ name: n, color: colorFor(n, i++) });
    return out;
  }

  /** Free (non-reserved) tags, in order. */
  userTags(): TagDef[] {
    return this.allTags().filter((t) => !RESERVED_TAGS.includes(t.name));
  }

  color(name: string): string {
    return this.allTags().find((t) => t.name === name)?.color ?? "#94a3b8";
  }

  get(key: string): string[] {
    return this.data.presets[key] ?? this.codeTags.get(key) ?? [];
  }

  has(key: string, tag: string): boolean {
    return this.get(key).includes(tag);
  }

  /** True when the tags of this preset come from code, not from the user. */
  isSeeded(key: string): boolean {
    return !(key in this.data.presets) && this.codeTags.has(key);
  }

  set(key: string, tags: string[]) {
    this.data.presets[key] = [...new Set(tags)];
    this.emit();
  }

  ensureTag(raw: string): string {
    const name = normalizeTag(raw);
    if (!name) return "";
    if (!RESERVED_TAGS.includes(name) && !this.data.tags.some((t) => t.name === name)) {
      this.data.tags.push({ name, color: colorFor(name, this.data.tags.length) });
      this.emit();
    }
    return name;
  }

  toggle(key: string, raw: string) {
    const tag = this.ensureTag(raw);
    if (!tag) return;
    const cur = this.get(key);
    let next = cur.includes(tag) ? cur.filter((t) => t !== tag) : [...cur, tag];
    // energy levels are exclusive — a preset is one of them, not two
    if (!cur.includes(tag) && (ENERGY_TAGS as readonly string[]).includes(tag)) {
      next = next.filter((t) => t === tag || !(ENERGY_TAGS as readonly string[]).includes(t));
    }
    this.set(key, next);
  }

  /** Apply (or remove, when every key already has it) one tag on many. */
  toggleMany(keys: string[], raw: string) {
    const tag = this.ensureTag(raw);
    if (!tag || keys.length === 0) return;
    const all = keys.every((k) => this.has(k, tag));
    for (const k of keys) {
      const cur = this.get(k);
      let next = all ? cur.filter((t) => t !== tag) : cur.includes(tag) ? cur : [...cur, tag];
      if (!all && (ENERGY_TAGS as readonly string[]).includes(tag)) {
        next = next.filter((t) => t === tag || !(ENERGY_TAGS as readonly string[]).includes(t));
      }
      this.data.presets[k] = next;
    }
    this.emit();
  }

  /** Rename a preset key (user preset renamed / deleted → pass null). */
  move(from: string, to: string | null) {
    const v = this.data.presets[from];
    if (v === undefined) return;
    delete this.data.presets[from];
    if (to) this.data.presets[to] = v;
    this.emit();
  }

  deleteTag(name: string) {
    this.data.tags = this.data.tags.filter((t) => t.name !== name);
    for (const k of Object.keys(this.data.presets)) {
      this.data.presets[k] = this.data.presets[k].filter((t) => t !== name);
    }
    // seeded presets carrying it become user-owned without it
    for (const [k, v] of this.codeTags) {
      if (!(k in this.data.presets) && v.includes(name)) {
        this.data.presets[k] = v.filter((t) => t !== name);
      }
    }
    this.emit();
  }

  /** Matches a tag filter. `★` stands for favourites. */
  matches(key: string, filter: string[], mode: "any" | "all", favorites: string[]): boolean {
    if (filter.length === 0) return true;
    const test = (t: string) => (t === "★" ? favorites.includes(key) : this.has(key, t));
    return mode === "all" ? filter.every(test) : filter.some(test);
  }
}

export const tagStore = new TagStore();

/** Re-renders the caller whenever any tag changes. */
export function useTags(): number {
  return useSyncExternalStore(tagStore.subscribe, tagStore.getVersion);
}
