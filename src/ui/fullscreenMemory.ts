// Fullscreen comes back where it was: if vizzy was last in fullscreen on the
// TV, the next start goes straight there. Together with presentation mode
// that makes "start the app → the picture runs on the TV" one step.

import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { availableMonitors, currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";

const inTauri = "__TAURI_INTERNALS__" in window;
const KEY = "vizzy.fullscreen";

type Saved = { on: boolean; monitor: string | null; x: number; y: number };

function load(): Saved | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return v && typeof v.on === "boolean" ? v : null;
  } catch {
    return null;
  }
}

/** Call after every fullscreen change made by vizzy. */
export async function rememberFullscreen(on: boolean): Promise<void> {
  if (!inTauri) return;
  try {
    const m = await currentMonitor();
    const saved: Saved = {
      on,
      monitor: m?.name ?? null,
      x: m?.position.x ?? 0,
      y: m?.position.y ?? 0,
    };
    localStorage.setItem(KEY, JSON.stringify(saved));
  } catch {
    // remembering is a convenience — never break fullscreen over it
  }
}

/** On start: back into fullscreen on the same monitor, if it is still there. */
export async function restoreFullscreen(): Promise<string | null> {
  if (!inTauri) return null;
  const saved = load();
  if (!saved?.on) return null;
  try {
    const win = getCurrentWindow();
    const monitors = await availableMonitors();
    const m =
      monitors.find((x) => saved.monitor && x.name === saved.monitor) ??
      monitors.find((x) => x.position.x === saved.x && x.position.y === saved.y);
    if (m) await win.setPosition(new PhysicalPosition(m.position.x + 40, m.position.y + 40));
    await win.setFullscreen(true);
    return m?.name ?? null;
  } catch {
    return null;
  }
}
