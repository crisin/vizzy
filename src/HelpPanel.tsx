import type { RefObject } from "react";
import { useDialogFocus } from "./useDialogFocus";
import { KEYS, type KeyScope } from "./keys";

const GROUPS: { title: string; scope: KeyScope }[] = [
  { title: "Überall", scope: "global" },
  { title: "Milkdrop", scope: "milkdrop" },
];

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
      {GROUPS.map((g) => (
        <section key={g.scope}>
          <h3>Tasten · {g.title}</h3>
          <dl className="shortcut-grid">
            {KEYS.filter((k) => k.scope === g.scope).map((k) => (
              <div key={k.id}>
                <dt>
                  <kbd>{k.label}</kbd>
                </dt>
                <dd>{k.does}</dd>
              </div>
            ))}
            {g.scope === "global" && (
              <div>
                <dt>
                  <kbd>Esc</kbd>
                </dt>
                <dd>Offenes Panel schließen (das Vollbild bleibt)</dd>
              </div>
            )}
          </dl>
        </section>
      ))}
      <h3>Auto-Wechsel im Takt</h3>
      <p className="help-intro">
        Vizzy hört das Tempo mit und zählt Takte und 32er-Phrasen mit. Steht der
        Auto-Wechsel auf „4 Takte“, ist die Wartezeit in den Einstellungen nur
        die Untergrenze — gewechselt wird danach auf der nächsten Taktgrenze,
        nicht mitten im Beat.
      </p>
      <p className="help-tip">
        Tipp: Bewege die Maus oder drücke eine Taste, um die Steuerung wieder
        einzublenden. Im Präsentationsmodus (H) bleibt sie weg — dann holt H
        oder jede Taste, die ein Panel öffnet, sie zurück.
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
