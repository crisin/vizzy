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
import { ParamRow, Section } from "./ui/ParamRow";
import { bridgeInfo, onBridgeChange } from "./milkdrop/bridgeClient";

const inTauri = "__TAURI_INTERNALS__" in window;

/** One line that tells every build apart: version, build number (commit
 *  count), commit, bundle time — and whether this is a dev server rather
 *  than a bundle. The values are baked in by vite.config.ts. */
const BUILD_ID = (() => {
  const b = __VIZZY_BUILD__;
  const when = new Date(b.builtAt).toLocaleString("de-DE", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const mode = import.meta.env.DEV ? " · dev" : "";
  return `vizzy ${b.version} · Build ${b.build} · ${b.commit} · ${when}${mode}`;
})();

/** Parameters with side effects beyond the render loop. */
function applySideEffects(group: string, key: string, value: number) {
  if (group === "audio" && key === "beatSigma" && inTauri) {
    invoke("set_beat_sensitivity", { sigma: value }).catch(console.error);
  }
}

// Fixed tabs, always in the same order — what does not apply to the current
// mode is greyed out with a hint, never removed (the bar must not rearrange
// itself under the pointer).
const TABS = [
  { id: "audio", label: "Audio" },
  { id: "bild", label: "Bild" },
  { id: "auto", label: "Automatik" },
  { id: "ui", label: "Bedienung" },
  { id: "system", label: "System" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/** Old tab ids that are now a section inside another tab. Opening one
 *  shows that tab and scrolls to the section (`drawer-sec-<id>`). */
const TAB_ALIAS: Record<string, string> = {
  routing: "audio",
  comfy: "bild",
  milkdrop: "auto",
};


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

/** Where the dev bridge listens — refreshes when it starts or stops. */
function BridgeStatus() {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const off = onBridgeChange(bump);
    return () => {
      off();
    };
  }, []);
  const info = bridgeInfo();
  if (!info) return null;
  return (
    <p className="set-note">
      Brücke läuft auf <code>127.0.0.1:{info.port}</code>. Port und Token
      stehen in <code>{info.file}</code> — Claude Code liest sie dort.
    </p>
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
  presentation: boolean;
  onPresentation: (value: boolean) => void;

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

  /** frequency routing, shown as a section of the Audio tab */
  routing: ReactNode;
  /** ComfyUI baking, a section of the Bild tab where a scene can use it */
  comfy: ReactNode | null;

  onResetAll: () => void;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;

  /** controlled tab — the drawer is opened on a specific tab from outside */
  tab: string;
  onTab: (tab: string) => void;
  /** tabs whose content lives elsewhere (tweaks, layer B, help) */
  extraTabs: DrawerTab[];
};

export type DrawerTab = {
  id: string;
  label: string;
  content: ReactNode;
  /** placed after this built-in tab; default: at the end */
  after?: TabId;
  /** set when the tab does not apply right now: why, shown instead */
  inactive?: string;
  /** offered next to the hint, e.g. "switch to Milkdrop" */
  activate?: { label: string; run: () => void };
  title?: string;
}

const WIDTH_KEY = "vizzy.drawer.width";
const MIN_W = 340;

function loadWidth(): number {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(v) && v >= MIN_W ? v : 440;
  } catch {
    return 440;
  }
}

export function SettingsPanel(props: SettingsPanelProps) {
  const tab = props.tab;
  const setTab = props.onTab;
  const [width, setWidth] = useState(loadWidth);
  // Publish the width so the toolbar rows can move out of the drawer's way
  // instead of disappearing under it (App.css, .hud-sub).
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--drawer-open-w", `${width}px`);
    return () => {
      root.style.removeProperty("--drawer-open-w");
    };
  }, [width]);
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = width;
    const move = (ev: PointerEvent) => {
      const w = Math.max(MIN_W, Math.min(window.innerWidth - 40, w0 + (x0 - ev.clientX)));
      setWidth(w);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setWidth((w) => {
        try {
          localStorage.setItem(WIDTH_KEY, String(Math.round(w)));
        } catch {
          // ignore
        }
        return w;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const allTabs: { id: string; label: string; inactive?: string; title?: string }[] = [];
  for (const t of TABS) {
    allTabs.push(t);
    for (const x of props.extraTabs) if (x.after === t.id) allTabs.push(x);
  }
  for (const x of props.extraTabs) if (!x.after) allTabs.push(x);
  const shown = TAB_ALIAS[tab] ?? tab;
  const extra = props.extraTabs.find((x) => x.id === shown);
  // an alias means "that section": bring it into view
  useEffect(() => {
    if (!TAB_ALIAS[tab]) return;
    const id = window.setTimeout(() => {
      document.getElementById(`drawer-sec-${tab}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
    }, 30);
    return () => window.clearTimeout(id);
  }, [tab]);
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
      className="settings-panel drawer"
      style={{ ["--drawer-w" as string]: `${width}px` }}
      role="dialog"
      aria-modal="false"
      aria-labelledby="settings-title"
    >
      <div
        className="drawer-grip"
        onPointerDown={startDrag}
        onDoubleClick={() => setWidth(440)}
        title="Breite ziehen · Doppelklick: Standard"
        aria-hidden="true"
      />
      <div className="settings-head">
        <h2 id="settings-title">
          {shown === "help" ? "Hilfe" : (allTabs.find((t) => t.id === shown)?.label ?? "Einstellungen")}
        </h2>
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
        {allTabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`settings-tab-${t.id}`}
            aria-selected={shown === t.id}
            aria-controls="settings-body"
            className={`settings-tab ${shown === t.id ? "active" : ""} ${t.inactive ? "inactive" : ""}`}
            title={t.inactive ?? t.title}
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
        aria-labelledby={`settings-tab-${shown}`}
      >
        {extra &&
          (extra.inactive ? (
            <div className="drawer-inactive">
              <p>{extra.inactive}</p>
              {extra.activate && (
                <button type="button" className="mode-btn" onClick={extra.activate.run}>
                  {extra.activate.label}
                </button>
              )}
            </div>
          ) : (
            <div className="drawer-embed">{extra.content}</div>
          ))}

        {shown === "audio" && (
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
            <div id="drawer-sec-routing" className="drawer-embed drawer-sec">
              {props.routing}
            </div>
          </>
        )}

        {shown === "bild" && (
          <>
            {props.paramGroups
              // the Milkdrop tab already shows this group
              .filter((g) => g !== "milkdrop")
              .map((g) => (
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
            {props.comfy && (
              <div id="drawer-sec-comfy" className="drawer-embed drawer-sec">
                {props.comfy}
              </div>
            )}
          </>
        )}

        {shown === "auto" && (
          <>
            {!props.milkdropAvailable && (
              <p className="set-note drawer-inactive-note">
                Der Auto-Wechsel wählt Milkdrop-Presets — er wirkt, sobald
                Milkdrop läuft (Taste 5).
              </p>
            )}
            <Field label="Auto-Wechsel">
              <label className="set-row set-row-toggle">
                <input
                  type="checkbox"
                  checked={props.autoSwitch}
                  onChange={(e) => props.onAutoSwitch(e.target.checked)}
                />
                <span className="set-label">
                  Preset automatisch wechseln
                  <small className="set-hint">
                    Wechselt im Takt, frühestens nach der Wartezeit unten · Taste A
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
                    {props.favorites.length === 0
                      ? "Noch keine Favoriten — in der Library oder mit S markieren"
                      : `${props.favorites.length} Favoriten · gilt für ←/→, Zufall und Auto`}
                  </small>
                </span>
              </label>
            </Field>
            <ParamGroup group="milkdrop" title="Wann und wohin gewechselt wird" onChanged={bump} />
            <p className="set-note">
              Favoriten und eigene Presets verwaltest du in der Library (L), Regeln
              pro Song oder Playlist in der Regie (G).
            </p>
          </>
        )}

        {shown === "ui" && (
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
            <Field label="Live">
              <label className="set-row set-row-toggle">
                <input
                  type="checkbox"
                  checked={props.presentation}
                  onChange={(e) => props.onPresentation(e.target.checked)}
                />
                <span className="set-label">
                  Präsentationsmodus
                  <small className="set-hint">
                    Leiste und Mauszeiger bleiben weg, Tasten wirken weiter. Taste H
                    schaltet zurück, ebenso jede Taste, die ein Panel öffnet.
                  </small>
                </span>
              </label>
            </Field>
            <Field label="Anzeigen">
              <label className="set-row set-row-toggle">
                <input
                  type="checkbox"
                  checked={props.showBpm}
                  onChange={(e) => props.onShowBpm(e.target.checked)}
                />
                <span className="set-label">
                  Tempo-Anzeige (BPM)
                  <small className="set-hint">Dauerhaft oben in der Leiste · Taste I blendet das Tempo kurz ein</small>
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

        {shown === "system" && (
          <>
            <ParamGroup group="dev" onChanged={bump} />
            <BridgeStatus />
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
              <p className="set-note build-id" title={BUILD_ID}>
                {BUILD_ID}
              </p>
            </Field>
          </>
        )}
      </div>
    </aside>
  );
}
