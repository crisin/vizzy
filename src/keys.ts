// The one list of keyboard shortcuts. The global handler in App.tsx, the
// help window and the tooltips all read from here, so they cannot drift
// apart. Keys that only mean something inside a panel (tag bar 1–9, Ctrl+S
// in the studio) stay with that panel.

export type KeyScope = "global" | "milkdrop" | "3d";

export type KeyId =
  | "mode"
  | "fullscreen"
  | "settings"
  | "cockpit"
  | "regie"
  | "help"
  | "presentation"
  | "info"
  | "debug"
  | "prev"
  | "next"
  | "random"
  | "auto"
  | "fav"
  | "library"
  | "studio"
  | "tagbar"
  | "layerB"
  | "layerBSettings"
  | "queueAdd"
  | "queueClear"
  | "queueNext"
  | "rateUp"
  | "rateDown";

export type KeyBinding = {
  id: KeyId;
  /** as shown to people, e.g. "Shift+B" */
  label: string;
  /** what it does, one short line */
  does: string;
  scope: KeyScope;
  match: (e: KeyboardEvent) => boolean;
  /** opens a panel or workshop — leaves presentation mode first */
  opensUi?: boolean;
  /** stop the keystroke from landing in a field that gets focus */
  preventDefault?: boolean;
};

const letter =
  (l: string, shift = false) =>
  (e: KeyboardEvent) =>
    e.key.toLowerCase() === l && e.shiftKey === shift && !e.ctrlKey && !e.metaKey && !e.altKey;

const MODE_COUNT = 6;

export const KEYS: KeyBinding[] = [
  // ------------------------------------------------------------- global
  {
    id: "mode",
    label: `1–${MODE_COUNT}`,
    does: "Visualisierung wechseln",
    scope: "global",
    match: (e) => !e.ctrlKey && !e.metaKey && !e.altKey && e.key >= "1" && e.key <= String(MODE_COUNT),
  },
  {
    id: "fullscreen",
    label: "F",
    does: "Vollbild an/aus",
    scope: "global",
    match: (e) => letter("f")(e) || e.key === "F11",
    preventDefault: true,
  },
  {
    id: "presentation",
    label: "H",
    does: "Präsentationsmodus: Bedienung bleibt weg, Tasten wirken weiter",
    scope: "global",
    match: letter("h"),
  },
  {
    id: "info",
    label: "I",
    does: "Info einblenden: Song, Preset, Tempo",
    scope: "global",
    match: letter("i"),
  },
  {
    id: "settings",
    label: "E",
    does: "Einstellungen",
    scope: "global",
    match: (e) => letter("e")(e) || e.key === ",",
    opensUi: true,
  },
  {
    id: "cockpit",
    label: "C",
    does: "Cockpit: laufender Song, Regie, Queue",
    scope: "global",
    match: letter("c"),
    opensUi: true,
  },
  {
    id: "regie",
    label: "G",
    does: "Regie: Regeln, Pools, Choreografien",
    scope: "global",
    match: letter("g"),
    opensUi: true,
    preventDefault: true,
  },
  {
    id: "debug",
    label: "D",
    does: "Diagnose (fps, Audio, Fehler)",
    scope: "global",
    match: letter("d"),
  },
  {
    id: "help",
    label: "?",
    does: "Hilfe und Tastenkürzel",
    scope: "global",
    match: (e) => e.key === "?",
    opensUi: true,
  },

  // ----------------------------------------------------------- milkdrop
  {
    id: "prev",
    label: "←",
    does: "Vorheriges Preset / vorherige Szene",
    scope: "global",
    match: (e) => e.key === "ArrowLeft" && !e.shiftKey && !e.ctrlKey && !e.altKey,
  },
  {
    id: "next",
    label: "→",
    does: "Nächstes Preset / nächste Szene",
    scope: "global",
    match: (e) => e.key === "ArrowRight" && !e.shiftKey && !e.ctrlKey && !e.altKey,
  },
  { id: "random", label: "R", does: "Zufälliges Preset", scope: "milkdrop", match: letter("r") },
  { id: "auto", label: "A", does: "Automatischer Wechsel an/aus", scope: "milkdrop", match: letter("a") },
  { id: "fav", label: "S", does: "Favorit an/aus (★)", scope: "milkdrop", match: letter("s") },
  {
    id: "library",
    label: "L",
    does: "Preset-Library",
    scope: "milkdrop",
    match: letter("l"),
    opensUi: true,
    preventDefault: true,
  },
  {
    id: "studio",
    label: "P",
    does: "Preset-Studio: anpassen, mischen, Code, Remix",
    scope: "milkdrop",
    match: letter("p"),
    opensUi: true,
    preventDefault: true,
  },
  {
    id: "tagbar",
    label: "T",
    does: "Laufendes Preset taggen (dort 1–9)",
    scope: "milkdrop",
    match: letter("t"),
    opensUi: true,
  },
  { id: "layerB", label: "B", does: "Layer B an/aus", scope: "milkdrop", match: letter("b") },
  {
    id: "layerBSettings",
    label: "Shift+B",
    does: "Layer-B-Einstellungen",
    scope: "milkdrop",
    match: letter("b", true),
    opensUi: true,
  },
  { id: "queueAdd", label: "Q", does: "Laufendes Preset einreihen", scope: "milkdrop", match: letter("q") },
  { id: "queueClear", label: "Shift+Q", does: "Queue leeren", scope: "milkdrop", match: letter("q", true) },
  { id: "queueNext", label: "N", does: "Nächsten Queue-Eintrag spielen", scope: "milkdrop", match: letter("n") },
  {
    id: "rateUp",
    label: "+",
    does: "Gefällt: bewerten, Zucht-Kind behalten",
    scope: "milkdrop",
    match: (e) => (e.key === "+" || e.key === "=") && !e.ctrlKey && !e.metaKey,
  },
  {
    id: "rateDown",
    label: "−",
    does: "Gefällt nicht: bewerten und weiter",
    scope: "milkdrop",
    match: (e) => e.key === "-" && !e.ctrlKey && !e.metaKey,
  },
];

/** The binding for this keystroke in the current mode, if any. */
export function matchKey(e: KeyboardEvent, mode: string): KeyBinding | undefined {
  return KEYS.find((k) => (k.scope === "global" || k.scope === mode) && k.match(e));
}

/** "Titel (Taste)" for buttons and tooltips. */
export function withKey(text: string, id: KeyId): string {
  const k = KEYS.find((b) => b.id === id);
  return k ? `${text} (${k.label})` : text;
}

export function keyLabel(id: KeyId): string {
  return KEYS.find((b) => b.id === id)?.label ?? "";
}
