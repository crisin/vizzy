// Every setting, findable by name: an index over the addressable controls
// (schema parameters, lyrics switches, the drawer's app switches) and the
// result list the drawer shows while its search field has text. A hit is
// the control itself — adjustable in place — under a link to its fixed
// place. Parameters of a scene that is not running can be set here too.

import { useReducer, type ReactNode } from "react";
import { GROUP_LABELS, PARAM_SCHEMAS } from "../params";
import { ParamControl, paramDef } from "./ParamControl";
import { revealSection } from "./ParamRow";
import { LyricsControl, hasLyricsControl } from "../lyrics/controls";

/** One control by reference ("param:group.key", "lyrics:id", "app:id"), or
 *  null when it no longer exists. */
export function renderControl(ref: string, app: Record<string, ReactNode>, onChanged: () => void): ReactNode {
  const [kind, rest = ""] = ref.split(":");
  if (kind === "param") {
    const dot = rest.indexOf(".");
    const group = rest.slice(0, dot);
    const def = paramDef(group, rest.slice(dot + 1));
    return def ? <ParamControl key={ref} group={group} def={def} onChanged={onChanged} /> : null;
  }
  if (kind === "lyrics") return hasLyricsControl(rest) ? <LyricsControl key={ref} id={rest} /> : null;
  if (kind === "app") return rest in app ? <div key={ref}>{app[rest]}</div> : null;
  return null;
}

const TAB_LABELS: Record<string, string> = {
  audio: "Audio",
  bild: "Bild",
  auto: "Automatik",
  ui: "Bedienung",
  lyrics: "Lyrics",
  system: "System",
};

/** parameter groups that are not in "Bild" */
const GROUP_TAB: Record<string, string> = {
  audio: "audio",
  milkdrop: "auto",
  react: "auto",
  ui: "ui",
  overlay: "ui",
  lyrics: "lyrics",
  lyricsTent: "lyrics",
  dev: "system",
};

type Item = {
  ref: string;
  /** lower-case text the query is matched against */
  hay: string;
  tab: string;
  section?: string;
  /** "Lyrics → Protokoll" */
  place: string;
};

// switches that are not schema parameters: what to find them by
const OTHER: [ref: string, words: string, tab: string, section?: string, sectionLabel?: string][] = [
  ["lyrics:enabled", "Live-Lyrics Whisper an aus Untertitel", "lyrics"],
  ["lyrics:profile", "Profil Erkennung schnell ausgeglichen akkurat", "lyrics"],
  ["lyrics:recordAll", "Alles mitschneiden Debug Aufnahme Audio Protokoll", "lyrics", "lyrics.log", "Protokoll"],
  ["lyrics:log", "Mitschreiben Protokoll Log Zeilen Debug", "lyrics", "lyrics.log", "Protokoll"],
  ["lyrics:logAudio", "Audio mitschneiden WAV Aufnahme", "lyrics", "lyrics.log", "Protokoll"],
  ["lyrics:takes", "Pro Song mitschreiben Aufnahmen Takes", "lyrics", "lyrics.takes", "Aufnahmen"],
  ["lyrics:takesUpload", "An Lyrics Helper senden hochladen Upload Aufnahmen", "lyrics", "lyrics.takes", "Aufnahmen"],
  ["app:autoSwitch", "Preset automatisch wechseln Auto-Wechsel", "auto"],
  ["app:favOnly", "Nur Favoriten verwenden Sterne", "auto"],
  ["app:presentation", "Präsentationsmodus Leiste Mauszeiger Party TV", "ui"],
  ["app:overlay", "Overlay-Modus durchsichtig Desktop Karaoke", "ui"],
  ["app:showBpm", "Tempo-Anzeige BPM", "ui"],
  ["app:debug", "Diagnose Frequenz-Analyse Debug", "ui"],
];

const INDEX: Item[] = [
  ...Object.entries(PARAM_SCHEMAS).flatMap(([group, defs]) => {
    const tab = GROUP_TAB[group] ?? "bild";
    // the Automatik tab gives this group its own heading
    const name = group === "milkdrop" ? "Wann und wohin gewechselt wird" : (GROUP_LABELS[group] ?? group);
    return defs.map((d) => ({
      ref: `param:${group}.${d.key}`,
      hay: `${d.label} ${d.hint ?? ""} ${name} ${TAB_LABELS[tab]} ${(d.options ?? []).map((o) => o.label).join(" ")}`.toLowerCase(),
      tab,
      section: `param.${group}`,
      place: `${TAB_LABELS[tab]} → ${name}`,
    }));
  }),
  ...OTHER.map(([ref, words, tab, section, sectionLabel]) => ({
    ref,
    hay: `${words} ${TAB_LABELS[tab]} ${sectionLabel ?? ""}`.toLowerCase(),
    tab,
    section,
    place: sectionLabel ? `${TAB_LABELS[tab]} → ${sectionLabel}` : TAB_LABELS[tab],
  })),
];

const MAX_HITS = 30;

export function SettingsSearch({
  query,
  app,
  onOpen,
}: {
  query: string;
  app: Record<string, ReactNode>;
  /** go to a hit's fixed place (the drawer clears the query) */
  onOpen: (tab: string) => void;
}) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = INDEX.filter((it) => words.every((w) => it.hay.includes(w)));
  if (hits.length === 0) {
    return (
      <p className="set-note">
        Nichts gefunden für „{query.trim()}“. Gesucht wird in Namen und Erklärungen aller Regler — probier ein
        kürzeres Wort, etwa „wellen“, „beat“ oder „overlay“.
      </p>
    );
  }
  const shown = hits.slice(0, MAX_HITS);
  const places = [...new Set(shown.map((h) => h.place))];
  return (
    <div className="set-search-results">
      {places.map((place) => {
        const group = shown.filter((h) => h.place === place);
        return (
          <section key={place} className="set-search-group">
            <button
              type="button"
              className="news-home"
              onClick={() => {
                onOpen(group[0].tab);
                if (group[0].section) revealSection(group[0].section);
              }}
            >
              {place} →
            </button>
            <div className="news-controls">{group.map((h) => renderControl(h.ref, app, bump))}</div>
          </section>
        );
      })}
      {hits.length > MAX_HITS && (
        <p className="set-note">
          {hits.length - MAX_HITS} weitere Treffer — tipp noch ein Wort dazu.
        </p>
      )}
    </div>
  );
}
