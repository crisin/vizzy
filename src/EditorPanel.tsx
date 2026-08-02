import { useReducer } from "react";
import { invoke } from "@tauri-apps/api/core";
import { GROUP_LABELS, PARAM_SCHEMAS, params } from "./params";

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
}: {
  groups: string[];
  onClose: () => void;
}) {
  const [, bump] = useReducer((n: number) => n + 1, 0);

  return (
    <div className="editor-panel">
      <div className="editor-head">
        <span>Parameter</span>
        <button className="mode-btn" onClick={onClose} title="Schließen (E)">
          ✕
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
                className="mode-btn editor-reset"
                disabled={params.isDefault(group)}
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
              const value = params.get(group, d.key);
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
                  <span className="editor-value">
                    {value.toFixed(d.step < 1 ? 2 : 0)}
                  </span>
                </label>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}
