import { invoke } from "@tauri-apps/api/core";
import { GROUP_LABELS, PARAM_SCHEMAS, params, type ParamDef } from "../params";
import { ParamRow, Section } from "./ParamRow";

const inTauri = "__TAURI_INTERNALS__" in window;

/** Parameters with side effects beyond the render loop. */
function applySideEffects(group: string, key: string, value: number) {
  if (group === "audio" && key === "beatSigma" && inTauri) {
    invoke("set_beat_sensitivity", { sigma: value }).catch(console.error);
  }
}

export /** One parameter group rendered from its schema — sliders, checkboxes and
 *  dropdowns all come out of the same declaration. */
function ParamGroup({
  group,
  title,
  onChanged,
}: {
  group: string;
  title?: string;
  onChanged: () => void;
}) {
  const defs = PARAM_SCHEMAS[group];
  if (!defs) return null;

  const commit = (d: ParamDef, value: number) => {
    params.set(group, d.key, value);
    applySideEffects(group, d.key, value);
    onChanged();
  };

  const name = title ?? GROUP_LABELS[group] ?? group;
  const changedCount = defs.filter(
    (d) => Math.abs(params.getBase(group, d.key) - d.default) > d.step / 2,
  ).length;
  return (
    <Section
      id={`param.${group}`}
      title={name}
      badge={changedCount ? `${changedCount} geändert` : undefined}
      resetDisabled={params.isDefault(group)}
      onReset={() => {
        params.reset(group);
        for (const d of defs) applySideEffects(group, d.key, d.default);
        onChanged();
      }}
    >
      {defs.map((d) => {
        const value = params.getBase(group, d.key);

        if (d.kind === "toggle") {
          return (
            <label key={d.key} className="set-row set-row-toggle">
              <input
                type="checkbox"
                checked={value >= 0.5}
                onChange={(e) => commit(d, e.target.checked ? 1 : 0)}
              />
              <span className="set-label">
                {d.label}
                {d.hint && <small className="set-hint">{d.hint}</small>}
              </span>
            </label>
          );
        }

        if (d.kind === "select") {
          return (
            <label key={d.key} className="set-row set-row-select">
              <span className="set-label">
                {d.label}
                {d.hint && <small className="set-hint">{d.hint}</small>}
              </span>
              <select
                className="src-select"
                value={value}
                onChange={(e) => commit(d, Number(e.target.value))}
              >
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
            key={d.key}
            label={d.label}
            hint={d.hint}
            value={value}
            min={d.min}
            max={d.max}
            step={d.step}
            unit={d.unit}
            defaultValue={d.default}
            onChange={(v) => commit(d, v)}
            onReset={() => commit(d, d.default)}
          />
        );
      })}
    </Section>
  );
}

