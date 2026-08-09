import { useState } from "react";
import { TWEAK_DEFS } from "./mdTweaks";
import { useDialogFocus } from "./useDialogFocus";

export function MdTweakPanel({
  presetKey,
  baseVals,
  overrides,
  onChange,
  onReset,
  onSave,
  onDeleteUser,
  onClose,
}: {
  presetKey: string;
  baseVals: Record<string, unknown>;
  overrides: Record<string, number>;
  onChange: (key: string, value: number) => void;
  onReset: () => void;
  onSave: (name: string) => void;
  onDeleteUser: (name: string) => void;
  onClose: () => void;
}) {
  const isUser = presetKey.startsWith("user:");
  const [name, setName] = useState(
    isUser ? presetKey.slice(5) : "Mein Preset",
  );
  const dirty = Object.keys(overrides).length > 0;
  const panelRef = useDialogFocus<HTMLElement>(false);

  return (
    <aside
      ref={panelRef}
      id="tweak-panel"
      className="editor-panel tweak-panel"
      role="dialog"
      aria-modal="false"
      aria-labelledby="tweak-title"
    >
      <div className="editor-head">
        <h2 id="tweak-title">Preset-Tweaks</h2>
        <button
          type="button"
          className="mode-btn"
          onClick={onClose}
          title="Schließen"
          aria-label="Preset-Tweaks schließen"
        >
          Schließen
        </button>
      </div>
      <div className="tweak-hint" title={presetKey}>
        {isUser ? `Eigenes Preset: ${presetKey.slice(5)}` : presetKey}
      </div>
      {TWEAK_DEFS.map((d) => {
        const base = baseVals[d.key];
        if (typeof base !== "number" && overrides[d.key] === undefined) {
          return null; // this preset doesn't use the property
        }
        const value =
          overrides[d.key] ?? (typeof base === "number" ? base : d.min);
        return (
          <label key={d.key} className="editor-row">
            <span
              className={`editor-label ${
                overrides[d.key] !== undefined ? "tweaked" : ""
              }`}
            >
              {d.label}
            </span>
            <input
              type="range"
              min={d.min}
              max={d.max}
              step={d.step}
              value={value}
              onChange={(e) => onChange(d.key, Number(e.target.value))}
            />
            <output className="editor-value">
              {value.toFixed(d.step >= 1 ? 0 : d.step >= 0.01 ? 2 : 3)}
            </output>
          </label>
        );
      })}
      <div className="editor-footer tweak-footer">
        <button
          className="mode-btn"
          disabled={!dirty}
          onClick={onReset}
          title="Alle Tweaks verwerfen"
        >
          Verwerfen
        </button>
        <input
          className="routing-name tweak-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Preset-Name"
        />
        <button
          className="mode-btn"
          disabled={name.trim() === ""}
          onClick={() => onSave(name.trim())}
          title="Als eigenes Preset speichern (★)"
        >
          💾 Speichern
        </button>
        {isUser && (
          <button
            className="mode-btn danger"
            onClick={() => onDeleteUser(presetKey.slice(5))}
            title="Dieses eigene Preset löschen"
          >
            🗑
          </button>
        )}
      </div>
    </aside>
  );
}
