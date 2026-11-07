// Saved layer setups ("Kombis"): preset A, layer B and how they mix, under a
// name. Stored in `combos.json` in the app data directory next to the tags
// (localStorage in the browser preview).

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { LayerBConfig } from "./layerB";

const inTauri = "__TAURI_INTERNALS__" in window;
const LS = "vizzy.combos.v1";
const FILE = "combos.json";

export type Combo = { name: string; a: string; b: LayerBConfig; created: number };

class ComboStore {
  private list: Combo[] = [];
  private listeners = new Set<() => void>();

  constructor() {
    try {
      this.list = JSON.parse(localStorage.getItem(LS) ?? "[]");
    } catch {
      this.list = [];
    }
    if (inTauri) {
      invoke<string | null>("data_read", { name: FILE })
        .then((s) => {
          if (s) {
            this.list = JSON.parse(s);
            this.emit(false);
          }
        })
        .catch(() => {});
    }
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = () => this.list;

  private emit(save = true) {
    this.list = [...this.list].sort((x, y) => x.name.localeCompare(y.name));
    for (const fn of this.listeners) fn();
    if (!save) return;
    const json = JSON.stringify(this.list, null, 1);
    try {
      localStorage.setItem(LS, json);
    } catch {
      // ignore
    }
    if (inTauri) void invoke("data_write", { name: FILE, contents: json }).catch(() => {});
  }

  save(c: Combo) {
    this.list = [...this.list.filter((x) => x.name !== c.name), c];
    this.emit();
  }

  remove(name: string) {
    this.list = this.list.filter((x) => x.name !== name);
    this.emit();
  }
}

export const comboStore = new ComboStore();

export function useCombos(): Combo[] {
  return useSyncExternalStore(comboStore.subscribe, comboStore.getSnapshot);
}
