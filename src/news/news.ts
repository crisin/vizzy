// What is new in vizzy, as data: the "Aktuell" tab of the settings drawer
// lists these entries, newest first, each with the controls it brought —
// live, the very same controls that sit at their fixed place.
//
// Adding a feature with a setting? Add an entry at the top. `controls`
// name existing controls:
//   "param:<group>.<key>"  a parameter of the schema (params.ts)
//   "lyrics:<id>"          a switch of the lyrics config (lyrics/controls.tsx)
//   "app:<id>"             app state the drawer gets as props (APP_CONTROLS)
// History takes care of itself: a control that no longer exists is left
// out, and an entry whose controls (or key) are all gone disappears.

import { useSyncExternalStore } from "react";
import { KEYS, type KeyId } from "../keys";
import { paramDef } from "../ui/ParamControl";
import { hasLyricsControl } from "../lyrics/controls";
import "./news.css";

/** App-state switches the settings drawer renders from its props. */
export const APP_CONTROLS = ["autoSwitch", "favOnly", "presentation", "overlay", "showBpm", "debug"] as const;
export type AppControlId = (typeof APP_CONTROLS)[number];

export type NewsEntry = {
  /** stable — "seen" is remembered by it */
  id: string;
  /** YYYY-MM-DD */
  date: string;
  title: string;
  text: string;
  controls?: string[];
  /** where the controls live for good: a drawer tab, optionally a section in it */
  home?: { tab: string; section?: string; label: string };
  /** the feature's shortcut (keys.ts); also proves the feature still exists */
  key?: KeyId;
};

export const NEWS: NewsEntry[] = [
  {
    id: "aktuell",
    date: "2026-11-17",
    title: "Aktuell",
    text: "Dieser Tab: was neu ist, mit den Reglern dazu. Jeder Regler hier ist derselbe wie an seinem festen Platz — der Link darunter führt hin.",
  },
  {
    id: "settings-wide",
    date: "2026-11-17",
    title: "Große Ansicht und „nur Geändertes“",
    text: "„⇤ Groß“ oben im Drawer macht aus der Seitenleiste eine breite Ansicht: Bereiche links, Inhalt in Spalten, unter Bild alle Szenen — das Bild läuft daneben weiter. „≠ Geändert“ zeigt in jedem Bereich nur, was vom Standard abweicht.",
  },
  {
    id: "settings-search",
    date: "2026-11-17",
    title: "Einstellungen durchsuchen",
    text: "Das Suchfeld oben im Drawer findet jeden Regler nach Name oder Erklärung — und zeigt ihn gleich zum Einstellen, auch Regler von Szenen, die gerade nicht laufen. Esc leert das Feld.",
  },
  {
    id: "lyrics-record-all",
    date: "2026-11-17",
    title: "Alles mitschneiden fürs Debuggen",
    text: "Ein Schalter für das volle Protokoll und das Audio dazu. Das Audio ist jetzt eine WAV pro Song, die jeder Player öffnet. Im Protokoll stehen zusätzlich die Media-Position, der Text aus Lyrics Helper und jede Entscheidung der Synchron-Uhr.",
    controls: ["lyrics:recordAll", "lyrics:log", "lyrics:logAudio"],
    home: { tab: "lyrics", section: "lyrics.log", label: "Lyrics → Protokoll" },
  },
  {
    id: "lyrics-takes",
    date: "2026-11-16",
    title: "Aufnahmen pro Song",
    text: "Was vizzy bei einem Song gehört hat, landet mit Songzeiten in einer Datei — als grober Entwurf für Lyrics Helper, von Hand oder automatisch dorthin geschickt.",
    controls: ["lyrics:takes", "lyrics:takesUpload"],
    home: { tab: "lyrics", section: "lyrics.takes", label: "Lyrics → Aufnahmen" },
  },
  {
    id: "lyrics-synced",
    date: "2026-11-14",
    title: "Synchrone Lyrics aus Lyrics Helper",
    text: "Kennt Lyrics Helper den Song mit Zeiten, zeigt vizzy diese Zeilen pünktlich und mit Vorschau. Whisper läuft als Uhr weiter.",
    controls: ["param:lyrics.source"],
    home: { tab: "lyrics", section: "param.lyrics", label: "Lyrics → Lyrics-Anzeige" },
  },
  {
    id: "react-voice",
    date: "2026-11-14",
    title: "Refrain und Gesang lösen etwas aus",
    text: "Kommt der Refrain wieder, setzt der Gesang ein oder beginnt ein Instrumental, kann das Bild wechseln, Layer B dazukommen oder Milkdrop einen Stoß bekommen.",
    controls: ["param:react.refrain", "param:react.voiceOn", "param:react.voiceOff", "param:react.osd"],
    home: { tab: "auto", section: "param.react", label: "Automatik → Reaktionen auf Gesang" },
  },
  {
    id: "lyrics-look",
    date: "2026-11-14",
    title: "Lyrics: Platzierung und Effekte",
    text: "Der Text kann wandern, Wellen ins Bild werfen und Milkdrop bei jeder neuen Zeile anstoßen. Der vorläufige Text hat ein eigenes Aussehen.",
    controls: ["param:lyrics.place", "param:lyrics.waves", "param:lyrics.kick", "param:lyricsTent.show"],
    home: { tab: "lyrics", section: "param.lyrics", label: "Lyrics → Lyrics-Anzeige" },
  },
  {
    id: "overlay",
    date: "2026-11-14",
    title: "Overlay-Modus",
    text: "vizzy liegt durchsichtig über dem ganzen Bildschirm, Klicks gehen zu den Fenstern darunter — etwa als Karaoke über dem Desktop. Raus mit Strg+Alt+V.",
    controls: ["app:overlay", "param:overlay.alpha", "param:overlay.show"],
    home: { tab: "ui", section: "param.overlay", label: "Bedienung → Overlay-Modus" },
    key: "overlay",
  },
  {
    id: "voice-mod",
    date: "2026-11-14",
    title: "Die Singstimme als Quelle",
    text: "Ob gerade jemand singt, erkennt vizzy am Stereobild — ohne Modell. Im Frequenz-Routing lässt sich die Stimme wie ein Band auf Parameter legen.",
    home: { tab: "routing", label: "Audio → Frequenz-Routing" },
  },
  {
    id: "lyrics-profiles",
    date: "2026-11-14",
    title: "Lyrics-Profile und Protokoll",
    text: "Drei gemessene Profile für die Erkennung — schneller oder genauer. Das Protokoll hält fest, was wann gehört wurde.",
    controls: ["lyrics:profile"],
    home: { tab: "lyrics", label: "Lyrics" },
  },
  {
    id: "lyrics-live",
    date: "2026-11-14",
    title: "Live-Lyrics",
    text: "Ein lokaler Whisper-Server schreibt mit, was gesungen wird, und vizzy zeigt es als Untertitel im Bild.",
    controls: ["lyrics:enabled"],
    home: { tab: "lyrics", label: "Lyrics" },
    key: "lyrics",
  },
  {
    id: "presentation",
    date: "2026-11-07",
    title: "Präsentationsmodus und Info-Einblendung",
    text: "Für TV und Party: Leiste und Mauszeiger bleiben weg. Song, Preset und Tempo lassen sich kurz einblenden, auf Wunsch bei jedem Songwechsel.",
    controls: ["app:presentation", "param:ui.infoOnSong"],
    home: { tab: "ui", label: "Bedienung" },
    key: "presentation",
  },
  {
    id: "regie",
    date: "2026-11-07",
    title: "Regie, Queue und Choreos",
    text: "Regeln und Pools entscheiden, was zu welchem Song, Künstler oder welcher Playlist läuft. Die Queue schlägt jede Regel, Choreos setzen Wechsel auf Takt und Abschnitt.",
    key: "regie",
  },
  {
    id: "cockpit",
    date: "2026-11-07",
    title: "Cockpit und Spotify",
    text: "Die linke Seitenleiste zeigt, was läuft und warum dieses Preset. Spotify und Lyrics Helper werden dort verbunden.",
    key: "cockpit",
  },
  {
    id: "md3d",
    date: "2026-11-07",
    title: "Milkdrop in den 3D-Szenen",
    text: "Das laufende Milkdrop-Preset als Hintergrund hinter jeder 3D-Szene. Die Regler stehen im Tab Bild, solange 3D läuft.",
    controls: ["param:md3d.bg", "param:md3d.bgHell"],
    home: { tab: "bild", section: "param.md3d", label: "Bild → Milkdrop in 3D" },
  },
  {
    id: "breeding",
    date: "2026-11-07",
    title: "Zucht",
    text: "Der Auto-Wechsel spielt Varianten der Presets, die du behältst, und entwickelt sich mit + und − dorthin, was dir gefällt.",
    controls: ["param:milkdrop.breed", "param:milkdrop.breedStrength", "param:milkdrop.breedCode"],
    home: { tab: "auto", section: "param.milkdrop", label: "Automatik → Wann und wohin gewechselt wird" },
  },
  {
    id: "dev-bridge",
    date: "2026-11-07",
    title: "Dev-Brücke für Claude Code",
    text: "Eine lokale Schnittstelle, über die Claude Code Presets rendert, den Zustand liest und Screenshots holt.",
    controls: ["param:dev.bridge"],
    home: { tab: "system", section: "param.dev", label: "System → Entwicklung" },
  },
  {
    id: "layer-b",
    date: "2026-11-07",
    title: "Layer B",
    text: "Ein zweites Milkdrop-Preset über dem ersten, mit Mischmodus und gespeicherten Kombis.",
    home: { tab: "layer", label: "Layer B" },
    key: "layerB",
  },
];

/** A control reference that still points at something. */
export function controlExists(ref: string): boolean {
  const [kind, rest = ""] = ref.split(":");
  if (kind === "param") {
    const dot = rest.indexOf(".");
    return dot > 0 && !!paramDef(rest.slice(0, dot), rest.slice(dot + 1));
  }
  if (kind === "lyrics") return hasLyricsControl(rest);
  if (kind === "app") return (APP_CONTROLS as readonly string[]).includes(rest);
  return false;
}

/** The feature behind the entry is still there. */
function alive(e: NewsEntry): boolean {
  if (e.controls?.length) return e.controls.some(controlExists);
  if (e.key) return KEYS.some((k) => k.id === e.key);
  return true;
}

/** Entries to show, newest first. */
export const VISIBLE_NEWS: NewsEntry[] = NEWS.filter(alive).sort((a, b) => b.date.localeCompare(a.date));

if (import.meta.env.DEV) {
  for (const e of NEWS) {
    for (const c of e.controls ?? []) {
      if (!controlExists(c)) console.warn(`[news] "${e.id}" names a control that is gone: ${c}`);
    }
  }
}

// ------------------------------------------------------------------ seen

const SEEN_KEY = "vizzy.news.seen";

class Seen {
  private ids: Set<string>;
  private unseenIds: string[] = [];
  private listeners = new Set<() => void>();

  constructor() {
    let stored: string[] | null = null;
    try {
      const v = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "null");
      if (Array.isArray(v)) stored = v.filter((x) => typeof x === "string");
    } catch {
      // unreadable: start over
    }
    // first start with this tab: only the newest day counts as new, not
    // the whole history
    const newest = VISIBLE_NEWS[0]?.date;
    this.ids = new Set(stored ?? VISIBLE_NEWS.filter((e) => e.date !== newest).map((e) => e.id));
    this.recount();
  }

  private recount() {
    this.unseenIds = VISIBLE_NEWS.filter((e) => !this.ids.has(e.id)).map((e) => e.id);
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  /** ids not seen yet (a stable array until something changes) */
  unseen = () => this.unseenIds;

  markAll() {
    if (!this.unseenIds.length) return;
    for (const e of VISIBLE_NEWS) this.ids.add(e.id);
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify([...this.ids]));
    } catch {
      // storage unavailable — seen for this session
    }
    this.recount();
    for (const fn of this.listeners) fn();
  }
}

export const newsSeen = new Seen();

/** How many entries have not been looked at — the dot on ⚙ and on the tab. */
export function useUnseenNews(): number {
  return useSyncExternalStore(newsSeen.subscribe, newsSeen.unseen).length;
}
