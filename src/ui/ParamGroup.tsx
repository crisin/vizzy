import { GROUP_LABELS, PARAM_SCHEMAS, params } from "../params";
import { Section } from "./ParamRow";
import { ParamControl, applySideEffects } from "./ParamControl";

/** One parameter group rendered from its schema — sliders, checkboxes and
 *  dropdowns all come out of the same declaration. */
export function ParamGroup({
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
      {defs.map((d) => (
        <ParamControl key={d.key} group={group} def={d} onChanged={onChanged} />
      ))}
    </Section>
  );
}
