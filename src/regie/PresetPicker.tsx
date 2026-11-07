// Preset (and combo) picker: a text field with suggestions. Used by the
// rule, pool and choreo editors.

import { useMemo, useState } from "react";
import { useCombos } from "../milkdrop/combos";
import { COMBO_PREFIX } from "./regieStore";

/** Text field with suggestions over all presets (and combos). */
export function PresetPicker({
  presetKeys,
  label,
  withCombos,
  placeholder,
  current,
  onPick,
}: {
  presetKeys: string[];
  label: (k: string) => string;
  withCombos?: boolean;
  placeholder: string;
  /** shown as the field's resting text, so the field doubles as the display */
  current?: string;
  onPick: (key: string) => void;
}) {
  const combos = useCombos();
  const [text, setText] = useState("");
  const [listId] = useState(() => `pp-${Math.random().toString(36).slice(2)}`);
  const options = useMemo(() => {
    const m = new Map<string, string>();
    if (withCombos) for (const c of combos) m.set(`Kombi: ${c.name}`, COMBO_PREFIX + c.name);
    for (const k of presetKeys) {
      const l = label(k);
      m.set(m.has(l) ? `${l} (${k})` : l, k);
    }
    return m;
  }, [presetKeys, label, combos, withCombos]);
  return (
    <>
      <input
        className={`regie-input ${current ? "has-current" : ""}`}
        list={listId}
        value={text}
        placeholder={current ?? placeholder}
        title={current ? `${current} — tippen zum Ändern` : undefined}
        onChange={(e) => {
          const v = e.target.value;
          const key = options.get(v);
          if (key) {
            onPick(key);
            setText("");
          } else setText(v);
        }}
      />
      <datalist id={listId}>
        {[...options.keys()].map((l) => (
          <option key={l} value={l} />
        ))}
      </datalist>
    </>
  );
}

export function entryLabel(e: string, label: (k: string) => string): string {
  return e.startsWith(COMBO_PREFIX) ? `Kombi: ${e.slice(COMBO_PREFIX.length)}` : label(e);
}
