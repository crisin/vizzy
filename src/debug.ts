// Global error collection for the debug HUD (key: D). Installed once at
// startup so errors accumulate from the very beginning — opening the HUD
// later still shows what already went wrong.

const MAX_ERRORS = 6;
const MAX_LEN = 200;

/** Newest last; render as-is. */
export const debugErrors: string[] = [];

function push(msg: string) {
  const t = new Date();
  const hh = String(t.getHours()).padStart(2, "0");
  const mm = String(t.getMinutes()).padStart(2, "0");
  const ss = String(t.getSeconds()).padStart(2, "0");
  const clean = msg.replace(/\s+/g, " ").trim().slice(0, MAX_LEN);
  // collapse repeats ("set_source failed" on every retry) into a counter
  const last = debugErrors[debugErrors.length - 1];
  const bare = last?.replace(/^\d\d:\d\d:\d\d /, "").replace(/ ×\d+$/, "");
  if (bare === clean) {
    const n = Number(last!.match(/ ×(\d+)$/)?.[1] ?? 1) + 1;
    debugErrors[debugErrors.length - 1] = `${hh}:${mm}:${ss} ${clean} ×${n}`;
    return;
  }
  debugErrors.push(`${hh}:${mm}:${ss} ${clean}`);
  if (debugErrors.length > MAX_ERRORS) debugErrors.shift();
}

/** For app code that reports failures outside console.error (e.g. flog). */
export function noteError(msg: string) {
  push(msg);
}

let installed = false;

export function installErrorCapture() {
  if (installed) return;
  installed = true;

  window.addEventListener("error", (e) => {
    push(e.message || String(e.error ?? "unknown error"));
  });
  window.addEventListener("unhandledrejection", (e) => {
    push(`unhandled: ${String(e.reason)}`);
  });

  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    push(
      args
        .map((a) => (a instanceof Error ? a.message : String(a)))
        .join(" "),
    );
    original(...args);
  };
}
