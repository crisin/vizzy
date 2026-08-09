import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { GROUP_LABELS, PARAM_SCHEMAS, params, type ParamDef } from "./params";
import { useDialogFocus } from "./useDialogFocus";
import type { UserPreset } from "./mdTweaks";

const inTauri = "__TAURI_INTERNALS__" in window;

/** Parameters with side effects beyond the render loop. */
function applySideEffects(group: string, key: string, value: number) {
  if (group === "audio" && key === "beatSigma" && inTauri) {
    invoke("set_beat_sensitivity", { sigma: value }).catch(console.error);
  }
}

const TABS = [
  { id: "audio", label: "Audio" },
  { id: "bild", label: "Bild" },
  { id: "milkdrop", label: "Milkdrop" },
  { id: "ui", label: "Bedienung" },
  { id: "system", label: "System" },
] as const;

type TabId = (typeof TABS)[number]["id"];

function formatValue(d: ParamDef, value: number): string {
  const text = value.toFixed(d.step < 1 ? 2 : 0);
  return d.unit ? `${text} ${d.unit}` : text;
}

/** One parameter group rendered from its schema — sliders, checkboxes and
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

  return (
    <section className="set-group">
      <div className="set-group-head">
        <span>{title ?? GROUP_LABELS[group] ?? group}</span>
        <button
          type="button"
          className="mode-btn set-reset"
          disabled={params.isDefault(group)}
          aria-label={`${GROUP_LABELS[group] ?? group} zurücksetzen`}
          onClick={() => {
            params.reset(group);
            for (const d of defs) applySideEffects(group, d.key, d.default);
            onChanged();
          }}
        >
          Reset
        </button>
      </div>
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
          <label key={d.key} className="set-row">
            <span className="set-label">
              {d.label}
              {d.hint && <small className="set-hint">{d.hint}</small>}
            </span>
            <input
              type="range"
              min={d.min}
              max={d.max}
              step={d.step}
              value={value}
              onChange={(e) => commit(d, Number(e.target.value))}
            />
            <output className="set-value">{formatValue(d, value)}</output>
          </label>
        );
      })}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="set-field">
      <span className="set-field-label">{label}</span>
      <div className="set-field-body">{children}</div>
    </div>
  );
}

export type SettingsPanelProps = {
  /** current visualization context — decides which parameter groups show */
  paramGroups: string[];
  milkdropAvailable: boolean;

  sources: { id: string; name: string; kind: string; is_default: boolean }[];
  apps: { pid: number; name: string; active: boolean }[];
  selectedSource: string;
  onSelectSource: (value: string) => void;
  onRefreshSources: () => void;

  uiScale: string;
  uiScales: readonly string[];
  uiScaleLabels: Record<string, string>;
  onUiScale: (value: string) => void;

  showBpm: boolean;
  onShowBpm: (value: boolean) => void;
  debugOpen: boolean;
  onDebug: (value: boolean) => void;

  bgLayer: string;
  bgLayers: readonly string[];
  onBgLayer: (value: string) => void;
  blendMode: string;
  blendModes: readonly string[];
  onBlendMode: (value: string) => void;
  showLayerControls: boolean;

  autoSwitch: boolean;
  onAutoSwitch: (value: boolean) => void;
  favOnly: boolean;
  onFavOnly: (value: boolean) => void;
  favorites: string[];
  onPickPreset: (key: string) => void;
  onUnfavorite: (key: string) => void;
  userPresets: UserPreset[];
  onDeleteUserPreset: (name: string) => void;

  onOpenRouting: () => void;
  onOpenTweaks: () => void;
  onResetAll: () => void;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
};

export function SettingsPanel(props: SettingsPanelProps) {
  const [tab, setTab] = useState<TabId>("audio");
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [armed, setArmed] = useState(false);
  const armTimer = useRef<number | undefined>(undefined);
  const panelRef = useDialogFocus<HTMLElement>(false, props.returnFocusRef);
  useEffect(() => () => window.clearTimeout(armTimer.current), []);

  const loopbacks = props.sources.filter((s) => s.kind === "loopback");
  const inputs = props.sources.filter((s) => s.kind === "input");

  return (
    <aside
      ref={panelRef}
      id="settings-panel"
      className="settings-panel"
      role="dialog"
      aria-modal="false"
      aria-labelledby="settings-title"
    >
      <div className="settings-head">
        <h2 id="settings-title">Einstellungen</h2>
        <button
          type="button"
          className="icon-btn"
          onClick={props.onClose}
          title="Schließen (Esc)"
          aria-label="Einstellungen schließen"
        >
          ✕
        </button>
      </div>

      <div className="settings-tabs" role="tablist" aria-label="Bereiche">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`settings-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="settings-body"
            className={`settings-tab ${tab === t.id ? "active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div
        className="settings-body"
        id="settings-body"
        role="tabpanel"
        aria-labelledby={`settings-tab-${tab}`}
      >
        {tab === "audio" && (
          <>
            {inTauri ? (
              <Field label="Audio-Quelle">
                <select
                  className="src-select set-wide"
                  value={props.selectedSource}
                  onChange={(e) => props.onSelectSource(e.target.value)}
                  onPointerDown={props.onRefreshSources}
                  aria-label="Audio-Quelle"
                >
                  <optgroup label="System-Audio (Loopback)">
                    {loopbacks.map((s) => (
                      <option key={s.id} value={`loopback|${s.id}`}>
                        {s.name}
                        {s.is_default ? " • Standard" : ""}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Eingänge (Mic / Line-In)">
                    {inputs.map((s) => (
                      <option key={s.id} value={`input|${s.id}`}>
                        {s.name}
                        {s.is_default ? " • Standard" : ""}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Einzelne App (Process-Loopback)">
                    {props.apps.map((a) => (
                      <option
                        key={`app-${a.pid}`}
                        value={`app|${a.pid}|${a.name}`}
                      >
                        {a.active ? "♪ " : ""}
                        {a.name} (PID {a.pid})
                      </option>
                    ))}
                  </optgroup>
                </select>
              </Field>
            ) : (
              <p className="set-note">
                Browser-Demo — es läuft ein animiertes Testsignal statt echter
                Audioquellen.
              </p>
            )}
            <ParamGroup group="audio" onChanged={bump} />
            <Field label="Frequenz-Routing">
              <button
                type="button"
                className="mode-btn"
                onClick={props.onOpenRouting}
              >
                Listener & Routing öffnen
              </button>
              <p className="set-note">
                Frequenzbänder auf beliebige Parameter legen — z.&nbsp;B. Bass
                auf Zoom.
              </p>
            </Field>
          </>
        )}

        {tab === "bild" && (
          <>
            {props.paramGroups.map((g) => (
              <ParamGroup key={g} group={g} onChanged={bump} />
            ))}
            {props.showLayerControls && (
              <>
                <Field label="Hintergrund-Layer">
                  <div className="set-seg">
                    {props.bgLayers.map((l) => (
                      <button
                        key={l}
                        type="button"
                        className={`mode-btn ${props.bgLayer === l ? "active" : ""}`}
                        onClick={() => props.onBgLayer(l)}
                        aria-pressed={props.bgLayer === l}
                      >
                        {l === "off" ? "aus" : l}
                      </button>
                    ))}
                  </div>
                </Field>
                {props.bgLayer !== "off" && (
                  <Field label="Blend-Modus">
                    <div className="set-seg">
                      {props.blendModes.map((b) => (
                        <button
                          key={b}
                          type="button"
                          className={`mode-btn ${props.blendMode === b ? "active" : ""}`}
                          onClick={() => props.onBlendMode(b)}
                          aria-pressed={props.blendMode === b}
                        >
                          {b}
                        </button>
                      ))}
                    </div>
                  </Field>
                )}
              </>
            )}
            <ParamGroup group="render" onChanged={bump} />
          </>
        )}

        {tab === "milkdrop" && (
          <>
            <ParamGroup group="milkdrop" onChanged={bump} />
            <Field label="Automatik">
              <label className="set-row set-row-toggle">
                <input
                  type="checkbox"
                  checked={props.autoSwitch}
                  onChange={(e) => props.onAutoSwitch(e.target.checked)}
                />
                <span className="set-label">
                  Preset automatisch wechseln
                  <small className="set-hint">
                    Wechselt auf einem Beat, frühestens nach der Wartezeit oben
                  </small>
                </span>
              </label>
              <label className="set-row set-row-toggle">
                <input
                  type="checkbox"
                  checked={props.favOnly}
                  onChange={(e) => props.onFavOnly(e.target.checked)}
                  disabled={props.favorites.length === 0}
                />
                <span className="set-label">
                  Nur Favoriten verwenden
                  <small className="set-hint">
                    Gilt für ←/→, Zufall und den Auto-Wechsel
                  </small>
                </span>
              </label>
            </Field>

            <Field label={`Favoriten (${props.favorites.length})`}>
              {props.favorites.length === 0 ? (
                <p className="set-note">
                  Noch keine — im Milkdrop-Modus mit dem ★ neben der
                  Preset-Auswahl oder mit der Taste S markieren.
                </p>
              ) : (
                <ul className="set-list">
                  {props.favorites.map((key) => (
                    <li key={key}>
                      <button
                        type="button"
                        className="set-list-name"
                        onClick={() => props.onPickPreset(key)}
                        title={`${key} laden`}
                      >
                        {key.startsWith("user:") ? key.slice(5) : key}
                      </button>
                      <button
                        type="button"
                        className="icon-btn set-list-del"
                        onClick={() => props.onUnfavorite(key)}
                        title="Aus Favoriten entfernen"
                        aria-label={`${key} aus Favoriten entfernen`}
                      >
                        ★
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Field>

            <Field label={`Eigene Presets (${props.userPresets.length})`}>
              {props.userPresets.length === 0 ? (
                <p className="set-note">
                  Über „Tweaks“ ein Preset verbiegen und speichern.
                </p>
              ) : (
                <ul className="set-list">
                  {props.userPresets.map((p) => (
                    <li key={p.name}>
                      <button
                        type="button"
                        className="set-list-name"
                        onClick={() => props.onPickPreset(`user:${p.name}`)}
                        title={`Basis: ${p.base}`}
                      >
                        {p.name}
                      </button>
                      <button
                        type="button"
                        className="icon-btn set-list-del danger"
                        onClick={() => props.onDeleteUserPreset(p.name)}
                        title="Eigenes Preset löschen"
                        aria-label={`${p.name} löschen`}
                      >
                        🗑
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <button
                type="button"
                className="mode-btn"
                onClick={props.onOpenTweaks}
                disabled={!props.milkdropAvailable}
              >
                Preset-Tweaks öffnen
              </button>
            </Field>
          </>
        )}

        {tab === "ui" && (
          <>
            <Field label="UI-Größe">
              <div className="set-seg">
                {props.uiScales.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`mode-btn ${props.uiScale === s ? "active" : ""}`}
                    onClick={() => props.onUiScale(s)}
                    aria-pressed={props.uiScale === s}
                  >
                    {props.uiScaleLabels[s] ?? s}
                  </button>
                ))}
              </div>
              <p className="set-note">
                Auto richtet sich nach dem Bildschirm, TV ist die große
                Couch-Ansicht.
              </p>
            </Field>
            <ParamGroup group="ui" onChanged={bump} />
            <Field label="Anzeigen">
              <label className="set-row set-row-toggle">
                <input
                  type="checkbox"
                  checked={props.showBpm}
                  onChange={(e) => props.onShowBpm(e.target.checked)}
                />
                <span className="set-label">
                  Tempo-Anzeige (BPM)
                  <small className="set-hint">Taste B</small>
                </span>
              </label>
              <label className="set-row set-row-toggle">
                <input
                  type="checkbox"
                  checked={props.debugOpen}
                  onChange={(e) => props.onDebug(e.target.checked)}
                />
                <span className="set-label">
                  Diagnose & Frequenz-Analyse
                  <small className="set-hint">Taste D</small>
                </span>
              </label>
            </Field>
          </>
        )}

        {tab === "system" && (
          <>
            <Field label="Zurücksetzen">
              <button
                type="button"
                className={`mode-btn danger ${armed ? "armed" : ""}`}
                onClick={() => {
                  if (armed) {
                    props.onResetAll();
                    return;
                  }
                  setArmed(true);
                  window.clearTimeout(armTimer.current);
                  armTimer.current = window.setTimeout(
                    () => setArmed(false),
                    3000,
                  );
                }}
              >
                {armed ? "Sicher? Nochmal klicken!" : "Alles zurücksetzen"}
              </button>
              <p className="set-note">
                Löscht alle Einstellungen, Parameter, Favoriten, eigene Presets
                und die Modell-Library. Danach startet die App neu.
              </p>
            </Field>
            <Field label="Über">
              <p className="set-note">
                Vizzy läuft komplett lokal — Audio-Analyse in Rust, Rendering im
                Fenster. Es verlässt nichts deinen Rechner.
              </p>
            </Field>
          </>
        )}
      </div>
    </aside>
  );
}
