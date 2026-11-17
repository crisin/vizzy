// One parameter of the schema as a control — slider, checkbox or dropdown
// from the same declaration. ParamGroup lists a whole group with it; the
// "Aktuell" tab shows single ones next to the news they belong to. One
// implementation, so a parameter looks and behaves the same in both places.

import { invoke } from "@tauri-apps/api/core";
import { PARAM_SCHEMAS, params, type ParamDef } from "../params";
import { ParamRow } from "./ParamRow";

const inTauri = "__TAURI_INTERNALS__" in window;

/** Parameters with side effects beyond the render loop. */
export function applySideEffects(group: string, key: string, value: number) {
  if (group === "audio" && key === "beatSigma" && inTauri) {
    invoke("set_beat_sensitivity", { sigma: value }).catch(console.error);
  }
}

export function paramDef(group: string, key: string): ParamDef | undefined {
  return PARAM_SCHEMAS[group]?.find((d) => d.key === key);
}

export function ParamControl({
  group,
  def: d,
  onChanged,
}: {
  group: string;
  def: ParamDef;
  onChanged: () => void;
}) {
  const value = params.getBase(group, d.key);
  const commit = (v: number) => {
    params.set(group, d.key, v);
    applySideEffects(group, d.key, v);
    onChanged();
  };

  const changed = Math.abs(value - d.default) > d.step / 2 ? "changed" : "";

  if (d.kind === "toggle") {
    return (
      <label className={`set-row set-row-toggle ${changed}`}>
        <input type="checkbox" checked={value >= 0.5} onChange={(e) => commit(e.target.checked ? 1 : 0)} />
        <span className="set-label">
          {d.label}
          {d.hint && <small className="set-hint">{d.hint}</small>}
        </span>
      </label>
    );
  }

  if (d.kind === "select") {
    return (
      <label className={`set-row set-row-select ${changed}`}>
        <span className="set-label">
          {d.label}
          {d.hint && <small className="set-hint">{d.hint}</small>}
        </span>
        <select className="src-select" value={value} onChange={(e) => commit(Number(e.target.value))}>
          {(d.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <ParamRow
      label={d.label}
      hint={d.hint}
      value={value}
      min={d.min}
      max={d.max}
      step={d.step}
      unit={d.unit}
      defaultValue={d.default}
      onChange={commit}
      onReset={() => commit(d.default)}
    />
  );
}
