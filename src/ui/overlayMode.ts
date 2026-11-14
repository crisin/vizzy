// Overlay mode, frontend side: vizzy over the whole desktop, see-through and
// click-through (the window part is src-tauri/src/overlay.rs). Here: the
// page drops its background and dims itself, and the global shortcuts
// (Ctrl+Alt+V, Ctrl+Alt+↑/↓) arrive as the `overlay` event.
//
// Never persisted: a restart always comes back as a normal window, so a
// forgotten overlay cannot hide the app behind its own click-through.

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { params } from "../params";

const inTauri = "__TAURI_INTERNALS__" in window;

type Listener = () => void;

class OverlayMode {
  on = false;
  private listeners = new Set<Listener>();
  /** OSD for the shortcut-driven changes (App sets it) */
  notify: (msg: string) => void = () => {};

  constructor() {
    if (inTauri) {
      void listen<{ action: "toggle" | "up" | "down" }>("overlay", (e) => {
        if (e.payload.action === "toggle") void this.set(!this.on);
        else this.nudge(e.payload.action === "up" ? 0.1 : -0.1);
      });
    }
    params.subscribe(() => this.apply());
  }

  subscribe = (fn: Listener) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = () => this.on;

  async set(on: boolean): Promise<void> {
    if (on === this.on) return;
    if (!inTauri) {
      this.notify("Overlay-Modus gibt es nur in der App");
      return;
    }
    try {
      await invoke("overlay_set", { on });
    } catch (e) {
      this.notify(`Overlay-Modus: ${e}`);
      return;
    }
    this.on = on;
    this.apply();
    for (const fn of this.listeners) fn();
    this.notify(on ? "Overlay an · Strg+Alt+V beendet · Strg+Alt+↑/↓ Deckkraft" : "Overlay aus");
  }

  toggle() {
    void this.set(!this.on);
  }

  private nudge(delta: number) {
    if (!this.on) return;
    const a = Math.min(1, Math.max(0.1, Math.round((params.get("overlay", "alpha") + delta) * 10) / 10));
    params.set("overlay", "alpha", a);
    this.notify(`Overlay-Deckkraft ${Math.round(a * 100)} %`);
  }

  /** classes and variables on <html>, see App.css (.overlay-mode) */
  private apply() {
    const root = document.documentElement;
    root.classList.toggle("overlay-mode", this.on);
    root.classList.toggle("overlay-lyrics-only", this.on && params.get("overlay", "show") === 1);
    root.style.setProperty("--overlay-alpha", String(params.get("overlay", "alpha")));
  }
}

export const overlayMode = new OverlayMode();

export function useOverlayMode(): boolean {
  return useSyncExternalStore(overlayMode.subscribe, overlayMode.getSnapshot);
}
