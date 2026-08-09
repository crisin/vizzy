import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type RefObject,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { GROUP_LABELS, PARAM_SCHEMAS, params } from "./params";
import { useDialogFocus } from "./useDialogFocus";

const inTauri = "__TAURI_INTERNALS__" in window;

/** Parameters with side effects beyond the render loop. */
function applySideEffects(group: string, key: string, value: number) {
  if (group === "audio" && key === "beatSigma" && inTauri) {
    invoke("set_beat_sensitivity", { sigma: value }).catch(console.error);
  }
}

export function EditorPanel({
  groups,
  onClose,
  onResetAll,
  returnFocusRef,
}: {
  groups: string[];
  onClose: () => void;
  onResetAll: () => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [armed, setArmed] = useState(false);
  const armTimer = useRef<number | undefined>(undefined);
  const panelRef = useDialogFocus<HTMLElement>(false, returnFocusRef);
  useEffect(() => () => window.clearTimeout(armTimer.current), []);

  return (
    <aside
      ref={panelRef}
      id="parameter-panel"
      className="editor-panel"
      role="dialog"
      aria-modal="false"
      aria-labelledby="parameter-title"
    >
      <div className="editor-head">
        <h2 id="parameter-title">Parameter</h2>
        <button
          type="button"
          className="mode-btn"
          onClick={onClose}
          title="Schließen (E)"
          aria-label="Parameter schließen"
        >
          Schließen
        </button>
      </div>
      {groups.map((group) => {
        const defs = PARAM_SCHEMAS[group];
        if (!defs) return null;
        return (
          <section key={group} className="editor-group">
            <div className="editor-group-head">
              <span>{GROUP_LABELS[group] ?? group}</span>
              <button
                type="button"
                className="mode-btn editor-reset"
                disabled={params.isDefault(group)}
                aria-label={`${GROUP_LABELS[group] ?? group} zurücksetzen`}
                onClick={() => {
                  params.reset(group);
                  for (const d of defs) {
                    applySideEffects(group, d.key, d.default);
                  }
                  bump();
                }}
              >
                Reset
              </button>
            </div>
            {defs.map((d) => {
              const value = params.getBase(group, d.key);
              return (
                <label key={d.key} className="editor-row">
                  <span className="editor-label">{d.label}</span>
                  <input
                    type="range"
                    min={d.min}
                    max={d.max}
                    step={d.step}
                    value={value}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      params.set(group, d.key, v);
                      applySideEffects(group, d.key, v);
                      bump();
                    }}
                  />
                  <output className="editor-value">
                    {value.toFixed(d.step < 1 ? 2 : 0)}
                  </output>
                </label>
              );
            })}
          </section>
        );
      })}
      <div className="editor-footer">
        <button
          type="button"
          className={`mode-btn danger ${armed ? "armed" : ""}`}
          onClick={() => {
            if (armed) {
              onResetAll();
            } else {
              setArmed(true);
              window.clearTimeout(armTimer.current);
              armTimer.current = window.setTimeout(
                () => setArmed(false),
                3000,
              );
            }
          }}
          title="Alle Einstellungen, Parameter und das gespeicherte Modell löschen"
        >
          {armed ? "Sicher? Nochmal klicken!" : "Alles zurücksetzen"}
        </button>
      </div>
    </aside>
  );
}
