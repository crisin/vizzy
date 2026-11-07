// The user's own presets, one JSON file each in `<app data>/presets/`.
//
// Files rather than webview storage so they can be shared, diffed, kept in
// git — and written from outside: the store polls the folder, so a preset
// saved by an editor or by Claude Code shows up (and reloads, if it is on
// screen) within a second or two. In the plain-browser preview it falls back
// to localStorage.
//
// Key scheme stays `user:<name>`, as before the move to files.

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { sanitize, fromLegacy, type VizzyPreset } from "./vpreset";
import { MD_PRESETS_STORAGE_KEY } from "../mdTweaks";

const inTauri = "__TAURI_INTERNALS__" in window;
const DIR = "presets";
const LS_KEY = "vizzy.vpresets.v1";
const POLL_MS = 1500;

type Entry = { name: string; modified: number };

class PresetStore {
  private list: VizzyPreset[] = [];
  private files = new Map<string, number>(); // file → mtime
  private fileOf = new Map<string, string>(); // preset id → file
  private listeners = new Set<() => void>();
  private snapshot: VizzyPreset[] = [];
  private ownWrites = new Set<string>();
  loaded = false;
  /** bumps whenever a preset's content changes, per user key */
  private versions = new Map<string, number>();

  constructor() {
    if (inTauri) {
      void this.initFiles();
    } else {
      try {
        const raw = JSON.parse(localStorage.getItem(LS_KEY) ?? "null");
        if (Array.isArray(raw)) this.list = raw.map(sanitize).filter((p): p is VizzyPreset => !!p);
        else this.list = this.legacy();
      } catch {
        this.list = this.legacy();
      }
      this.loaded = true;
      this.emit();
    }
  }

  private legacy(): VizzyPreset[] {
    try {
      const old = JSON.parse(localStorage.getItem(MD_PRESETS_STORAGE_KEY) ?? "[]");
      return Array.isArray(old) ? old.map(fromLegacy) : [];
    } catch {
      return [];
    }
  }

  private async initFiles() {
    try {
      const entries = await invoke<Entry[]>("data_list", { dir: DIR });
      if (entries.length === 0) {
        // first start with file storage: move the old presets over once
        for (const p of this.legacy()) await this.write(p);
      }
      await this.sync();
    } catch (e) {
      console.error("[presets] init failed", e);
    }
    this.loaded = true;
    this.emit();
    window.setInterval(() => {
      if (!document.hidden) void this.sync();
    }, POLL_MS);
  }

  /** Reads changed files, drops deleted ones. */
  private async sync() {
    const entries = await invoke<Entry[]>("data_list", { dir: DIR });
    let changed = false;
    const seen = new Set<string>();
    for (const e of entries) {
      seen.add(e.name);
      if (this.files.get(e.name) === e.modified) continue;
      this.files.set(e.name, e.modified);
      if (this.ownWrites.delete(e.name)) continue; // we just wrote it
      try {
        const raw = await invoke<string | null>("data_read", { name: e.name });
        const p = raw ? sanitize(JSON.parse(raw)) : null;
        if (!p) continue;
        this.list = this.list.filter((x) => x.id !== p.id && x.name !== p.name);
        this.list.push(p);
        this.fileOf.set(p.id, e.name);
        this.bump(p.name);
        changed = true;
      } catch (err) {
        console.warn("[presets] unreadable", e.name, err);
      }
    }
    for (const [file] of this.files) {
      if (seen.has(file)) continue;
      this.files.delete(file);
      const id = [...this.fileOf].find(([, f]) => f === file)?.[0];
      if (id) {
        this.fileOf.delete(id);
        this.list = this.list.filter((p) => p.id !== id);
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  private bump(name: string) {
    this.versions.set(name, (this.versions.get(name) ?? 0) + 1);
  }

  /** Content version of `user:<name>` — changes when the file changes. */
  version(name: string): number {
    return this.versions.get(name) ?? 0;
  }

  private async write(p: VizzyPreset) {
    const file = this.fileOf.get(p.id) ?? `${DIR}/${p.id}.json`;
    this.fileOf.set(p.id, file);
    this.ownWrites.add(file);
    await invoke("data_write", { name: file, contents: JSON.stringify(p, null, 2) });
  }

  private persistLocal() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(this.list));
    } catch {
      // ignore
    }
  }

  private emit() {
    this.list.sort((a, b) => a.name.localeCompare(b.name));
    this.snapshot = [...this.list];
    for (const fn of this.listeners) fn();
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = () => this.snapshot;

  byName(name: string): VizzyPreset | undefined {
    return this.list.find((p) => p.name === name);
  }

  /** Saves (creates or replaces by name). */
  async save(p: VizzyPreset): Promise<void> {
    const prev = this.byName(p.name);
    const next = { ...p, id: prev?.id ?? p.id, created: prev?.created ?? p.created, modified: Date.now() };
    this.list = this.list.filter((x) => x.name !== p.name && x.id !== next.id);
    this.list.push(next);
    this.bump(next.name);
    this.emit();
    if (inTauri) await this.write(next);
    else this.persistLocal();
  }

  async remove(name: string): Promise<void> {
    const p = this.byName(name);
    if (!p) return;
    this.list = this.list.filter((x) => x.id !== p.id);
    this.emit();
    if (inTauri) {
      const file = this.fileOf.get(p.id) ?? `${DIR}/${p.id}.json`;
      this.fileOf.delete(p.id);
      this.files.delete(file);
      await invoke("data_delete", { name: file });
    } else {
      this.persistLocal();
    }
  }

  /** Imports a preset file's text (Vizzy format, or raw Butterchurn JSON). */
  async importJson(text: string, fallbackName: string): Promise<VizzyPreset | null> {
    const raw = JSON.parse(text);
    let p = sanitize(raw);
    if (!p && raw && typeof raw === "object" && "baseVals" in raw) {
      // plain Butterchurn preset: every part inline
      const bc = raw as Record<string, unknown>;
      const { makePreset } = await import("./vpreset");
      p = makePreset(fallbackName, "", {
        parts: {
          baseVals: { inline: bc.baseVals as Record<string, number> },
          init: { inline: String(bc.init_eqs_eel ?? "") },
          frame: { inline: String(bc.frame_eqs_eel ?? "") },
          pixel: { inline: String(bc.pixel_eqs_eel ?? "") },
          warp: { inline: String(bc.warp ?? "") },
          comp: { inline: String(bc.comp ?? "") },
          waves: ((bc.waves as unknown[]) ?? []).map((w) => ({ inline: w })),
          shapes: ((bc.shapes as unknown[]) ?? []).map((s) => ({ inline: s })),
        },
        lineage: { parents: [], op: "import", at: Date.now() },
      });
    }
    if (!p) return null;
    let name = p.name;
    for (let i = 2; this.byName(name); i++) name = `${p.name} (${i})`;
    p = { ...p, name };
    await this.save(p);
    return p;
  }

  async openFolder() {
    if (!inTauri) return;
    await invoke("data_open_dir", { dir: DIR });
  }
}

export const presetStore = new PresetStore();

export function useUserPresets(): VizzyPreset[] {
  return useSyncExternalStore(presetStore.subscribe, presetStore.getSnapshot);
}
