import { useState } from "react";
import { TWEAK_DEFS, type TweakDef } from "./mdTweaks";
import { ParamRow, Section } from "./ui/ParamRow";

/** Tweaks grouped the way you think about a preset, not alphabetically. */
const GROUPS: { id: string; title: string; keys: string[] }[] = [
  { id: "motion", title: "Bewegung", keys: ["zoom", "zoomexp", "rot", "warp", "cx", "cy", "sx", "sy"] },
  { id: "trail", title: "Nachleuchten & Echo", keys: ["decay", "echo_zoom", "echo_alpha", "echo_orient"] },
  { id: "wave", title: "Wellenform", keys: ["wave_mode", "wave_a", "wave_scale", "wave_smoothing", "wave_x", "wave_y", "wave_mystery", "wave_dots", "additivewave"] },
  { id: "color", title: "Farbe & Helligkeit", keys: ["wave_r", "wave_g", "wave_b", "gammaadj", "brighten", "darken"] },
];

const DEF_BY_KEY = new Map(TWEAK_DEFS.map((d) => [d.key, d]));

/**
 * Preset tweaks — the "Anpassen" tab of the preset studio. Values are the
 * preset's own baseVals with the user's overrides on top; the reset arrow
 * per row drops that one override. The studio saves, so the footer with
 * name and save button is optional.
 */
export function MdTweakPanel({
  presetKey,
  baseVals,
  overrides,
  onChange,
  onReset,
  onResetKey,
  onSave,
  onDeleteUser,
  footer = true,
}: {
  presetKey: string;
  baseVals: Record<string, unknown>;
  overrides: Record<string, number>;
  onChange: (key: string, value: number) => void;
  onReset: () => void;
  onResetKey: (key: string) => void;
  onSave: (name: string) => void;
  onDeleteUser: (name: string) => void;
  footer?: boolean;
}) {
  const isUser = presetKey.startsWith("user:");
  const [name, setName] = useState(isUser ? presetKey.slice(5) : "Mein Preset");
  const [showAll, setShowAll] = useState(false);
  const dirty = Object.keys(overrides).length > 0;

  const row = (d: TweakDef) => {
    const base = baseVals[d.key];
    const used = typeof base === "number" || overrides[d.key] !== undefined;
    if (!used && !showAll) return null;
    const baseNum = typeof base === "number" ? base : d.min;
    const value = overrides[d.key] ?? baseNum;
    return (
      <ParamRow
        key={d.key}
        label={d.label}
        value={value}
        min={Math.min(d.min, value)}
        max={Math.max(d.max, value)}
        step={d.step}
        defaultValue={baseNum}
        changed={overrides[d.key] !== undefined}
        onChange={(v) => onChange(d.key, v)}
        onReset={() => onResetKey(d.key)}
      />
    );
  };

  return (
    <div className="tweaks">
      <div className="tweak-hint" title={presetKey}>
        {isUser ? `Eigenes Preset: ${presetKey.slice(5)}` : presetKey}
      </div>
      <label className="set-row set-row-toggle">
        <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
        <span className="set-label">
          Auch Werte zeigen, die das Preset nicht setzt
          <small className="set-hint">Sonst nur, was dieses Preset wirklich benutzt</small>
        </span>
      </label>
      {GROUPS.map((g) => {
        const defs = g.keys.map((k) => DEF_BY_KEY.get(k)).filter((d): d is TweakDef => !!d);
        const rows = defs.map(row).filter(Boolean);
        if (rows.length === 0) return null;
        const n = defs.filter((d) => overrides[d.key] !== undefined).length;
        return (
          <Section
            key={g.id}
            id={`tweak.${g.id}`}
            title={g.title}
            badge={n ? `${n} geändert` : undefined}
            resetDisabled={n === 0}
            onReset={() => defs.forEach((d) => overrides[d.key] !== undefined && onResetKey(d.key))}
          >
            {rows}
          </Section>
        );
      })}
      {footer && (
      <div className="tweak-footer">
        <button className="mode-btn" disabled={!dirty} onClick={onReset} title="Alle Tweaks verwerfen">
          Alles verwerfen
        </button>
        <input
          className="routing-name tweak-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Preset-Name"
          aria-label="Name für das eigene Preset"
        />
        <button
          className="mode-btn"
          disabled={name.trim() === ""}
          onClick={() => onSave(name.trim())}
          title="Als eigenes Preset speichern"
        >
          💾 Speichern
        </button>
        {isUser && (
          <button
            className="mode-btn danger"
            onClick={() => onDeleteUser(presetKey.slice(5))}
            title="Dieses eigene Preset löschen"
            aria-label="Eigenes Preset löschen"
          >
            🗑
          </button>
        )}
      </div>
      )}
    </div>
  );
}
