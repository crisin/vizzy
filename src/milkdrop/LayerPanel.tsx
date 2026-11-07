import { ParamRow } from "../ui/ParamRow";
import {
  DEFAULT_LAYER_B,
  LAYER_BAND_LABELS,
  LAYER_BLENDS,
  type LayerBConfig,
  type LayerBand,
} from "./layerB";

/** Drawer tab "Layer": a second preset over the main one. */
export function LayerPanel({
  cfg,
  onChange,
  presetKeys,
  label,
  currentKey,
  onPickFromLibrary,
  onSwap,
  error,
}: {
  cfg: LayerBConfig;
  onChange: (cfg: LayerBConfig) => void;
  presetKeys: string[];
  label: (key: string) => string;
  currentKey: string;
  onPickFromLibrary: () => void;
  onSwap: () => void;
  error: string;
}) {
  const set = <K extends keyof LayerBConfig>(k: K, v: LayerBConfig[K]) => onChange({ ...cfg, [k]: v });

  return (
    <div className="layer-panel">
      <p className="set-note">
        Ein zweites Preset läuft über dem ersten und wird per Blend-Modus
        hineingemischt. Jede Ebene kann auf einen anderen Teil des Spektrums
        hören — z.&nbsp;B. A auf den Bass, B auf die Höhen.
      </p>
      <label className="set-row set-row-toggle">
        <input type="checkbox" checked={cfg.enabled} onChange={(e) => set("enabled", e.target.checked)} />
        <span className="set-label">
          Layer B an
          <small className="set-hint">Taste Shift+B</small>
        </span>
      </label>

      <div className="set-field">
        <span className="set-field-label">Preset B</span>
        <div className="set-field-body layer-pick">
          <select
            className="src-select set-wide"
            value={cfg.key}
            onChange={(e) => onChange({ ...cfg, key: e.target.value, enabled: true })}
            aria-label="Preset für Layer B"
          >
            <option value="">— wählen —</option>
            {presetKeys.map((k) => (
              <option key={k} value={k}>
                {label(k)}
              </option>
            ))}
          </select>
          <div className="layer-actions">
            <button type="button" className="mode-btn" onClick={onPickFromLibrary}>
              Aus der Library…
            </button>
            <button
              type="button"
              className="mode-btn"
              onClick={onSwap}
              disabled={!cfg.key || cfg.key === currentKey}
              title="A und B tauschen"
            >
              A ⇄ B
            </button>
          </div>
          {error && <p className="set-hint comfy-err">{error}</p>}
        </div>
      </div>

      <div className="set-field">
        <span className="set-field-label">Mischung</span>
        <div className="set-field-body">
          <div className="set-seg layer-blends">
            {LAYER_BLENDS.map((b) => (
              <button
                key={b}
                type="button"
                className={`mode-btn ${cfg.blend === b ? "active" : ""}`}
                onClick={() => set("blend", b)}
                aria-pressed={cfg.blend === b}
              >
                {b}
              </button>
            ))}
          </div>
          <ParamRow label="Deckkraft B" value={cfg.opacity} min={0} max={1} step={0.01} defaultValue={DEFAULT_LAYER_B.opacity} onChange={(v) => set("opacity", v)} onReset={() => set("opacity", DEFAULT_LAYER_B.opacity)} />
          <ParamRow label="Pegel B" hint="Wie stark B die Musik hört" value={cfg.gain} min={0} max={3} step={0.05} defaultValue={DEFAULT_LAYER_B.gain} onChange={(v) => set("gain", v)} onReset={() => set("gain", DEFAULT_LAYER_B.gain)} />
          <ParamRow label="Auflösung B" hint="Weniger = schneller; weich gezeichnet passt oft sogar besser" value={cfg.scale} min={0.25} max={1} step={0.05} defaultValue={DEFAULT_LAYER_B.scale} onChange={(v) => set("scale", v)} onReset={() => set("scale", DEFAULT_LAYER_B.scale)} />
        </div>
      </div>

      <div className="set-field">
        <span className="set-field-label">Wer hört was</span>
        <div className="set-field-body">
          {(["bandA", "band"] as const).map((k) => (
            <label key={k} className="set-row set-row-select">
              <span className="set-label">{k === "bandA" ? "Layer A (Haupt-Preset)" : "Layer B"}</span>
              <select className="src-select" value={cfg[k]} onChange={(e) => set(k, Number(e.target.value) as LayerBand)}>
                {LAYER_BAND_LABELS.map((l, i) => (
                  <option key={l} value={i}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </div>

      <label className="set-row set-row-toggle">
        <input type="checkbox" checked={cfg.auto} onChange={(e) => set("auto", e.target.checked)} />
        <span className="set-label">
          B wechselt mit
          <small className="set-hint">
            Beim Auto-Wechsel von A zieht B einen Takt später nach — so
            wechselt nie das ganze Bild auf einmal
          </small>
        </span>
      </label>
    </div>
  );
}
