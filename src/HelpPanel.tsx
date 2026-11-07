import type { RefObject } from "react";
import { useDialogFocus } from "./useDialogFocus";

const SHORTCUTS = [
  ["1–6", "Visualisierung wechseln"],
  ["← / →", "Preset oder 3D-Szene wechseln"],
  ["R", "Zufälliges Milkdrop-Preset"],
  ["S", "Preset als Favorit markieren (★)"],
  ["L", "Preset-Library mit Vorschauen"],
  ["T", "Tag-Leiste: laufendes Preset taggen (dort 1–9)"],
  ["P", "Preset-Studio: mischen, Code, Remix"],
  ["Shift+B", "Layer B an/aus"],
  ["+ / −", "Preset bewerten; − wechselt sofort weiter, + behält ein Zucht-Kind"],
  ["A", "Automatischen Preset-Wechsel umschalten"],
  ["B", "Tempoanzeige ein- oder ausblenden"],
  ["D", "Diagnoseanzeige ein- oder ausblenden"],
  ["C", "Cockpit: laufender Song, aktive Regel, schnell zuordnen"],
  ["G", "Regie: Regeln (Song/Artist/Playlist → Bild) und Pools"],
  ["Q", "Laufendes Preset in die Queue (Shift+Q: Queue leeren)"],
  ["N", "Nächsten Queue-Eintrag sofort"],
  ["E", "Einstellungen öffnen"],
  ["F", "Vollbild umschalten"],
  ["?", "Diese Hilfe öffnen"],
  ["Esc", "Offenes Panel schließen"],
] as const;

export function HelpPanel({
  onClose,
  returnFocusRef,
  embedded = false,
}: {
  onClose: () => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  embedded?: boolean;
}) {
  const panelRef = useDialogFocus<HTMLElement>(false, returnFocusRef);

  const body = (
    <>
      <div className="editor-head">
        <h2 id="help-title">Schnellstart</h2>
        <button
          type="button"
          className="mode-btn"
          onClick={onClose}
          aria-label="Hilfe schließen"
        >
          Schließen
        </button>
      </div>
      <p className="help-intro">
        Wähle oben eine Visualisierung. In der Desktop-App reagiert sie auf die
        gewählte Audioquelle; im Browser läuft ein animiertes Demosignal.
      </p>
      <h3>Tastenkürzel</h3>
      <dl className="shortcut-grid">
        {SHORTCUTS.map(([key, description]) => (
          <div key={key}>
            <dt>
              <kbd>{key}</kbd>
            </dt>
            <dd>{description}</dd>
          </div>
        ))}
      </dl>
      <h3>Auto-Wechsel im Takt</h3>
      <p className="help-intro">
        Vizzy hört das Tempo mit und zählt Takte und 32er-Phrasen mit. Steht der
        Auto-Wechsel auf „4 Takte“, ist die Wartezeit in den Einstellungen nur
        die Untergrenze — gewechselt wird danach auf der nächsten Taktgrenze,
        nicht mitten im Beat.
      </p>
      <p className="help-tip">
        Tipp: Bewege die Maus oder drücke eine Taste, um die Steuerung wieder
        einzublenden.
      </p>
    </>
  );
  if (embedded) return body;
  return (
    <aside
      ref={panelRef}
      id="help-panel"
      className="editor-panel help-panel"
      role="dialog"
      aria-modal="false"
      aria-labelledby="help-title"
    >
      {body}
    </aside>
  );
}
