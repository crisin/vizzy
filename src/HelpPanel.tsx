import type { RefObject } from "react";
import { useDialogFocus } from "./useDialogFocus";

const SHORTCUTS = [
  ["1–5", "Visualisierung wechseln"],
  ["← / →", "Preset oder 3D-Szene wechseln"],
  ["R", "Zufälliges Milkdrop-Preset"],
  ["A", "Automatischen Preset-Wechsel umschalten"],
  ["B", "Tempoanzeige ein- oder ausblenden"],
  ["D", "Diagnoseanzeige ein- oder ausblenden"],
  ["E", "Parameter öffnen"],
  ["F", "Vollbild umschalten"],
  ["?", "Diese Hilfe öffnen"],
  ["Esc", "Offenes Panel schließen"],
] as const;

export function HelpPanel({
  onClose,
  returnFocusRef,
}: {
  onClose: () => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const panelRef = useDialogFocus<HTMLElement>(false, returnFocusRef);

  return (
    <aside
      ref={panelRef}
      id="help-panel"
      className="editor-panel help-panel"
      role="dialog"
      aria-modal="false"
      aria-labelledby="help-title"
    >
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
      <p className="help-tip">
        Tipp: Bewege die Maus oder drücke eine Taste, um die Steuerung wieder
        einzublenden.
      </p>
    </aside>
  );
}
