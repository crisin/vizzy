import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { BCVisualizer } from "butterchurn";
import { getBasePresetKeys } from "butterchurn-presets/presetPackMeta.js";
import { SCENE_NAMES, type SceneName } from "./sceneCatalog";
import type { Viz3D } from "./scenes3d";
import { params, PARAMS_STORAGE_KEY } from "./params";
import { EditorPanel } from "./EditorPanel";
import { debugErrors, installErrorCapture, noteError } from "./debug";
import {
  addModel,
  clearAllModels,
  deleteModel,
  getModel,
  listModels,
  updateThumb,
  type ModelMeta,
} from "./modelStore";
import { LibraryModal } from "./LibraryModal";
import { routing } from "./listeners";
import { RoutingModal } from "./RoutingModal";
import { MdTweakPanel } from "./MdTweakPanel";
import { HelpPanel } from "./HelpPanel";
import {
  deleteUserPreset,
  loadUserPresets,
  saveUserPreset,
} from "./mdTweaks";

/** Shallow preset copy with baseVals overrides applied. */
function mergeBaseVals(
  preset: unknown,
  overrides: Record<string, number>,
): unknown {
  const p = preset as { baseVals?: Record<string, unknown> };
  return { ...p, baseVals: { ...(p.baseVals ?? {}), ...overrides } };
}

type ModelAction =
  | { action: "load"; data: ArrayBuffer; name: string; seq: number }
  | { action: "clear"; seq: number };
import "./App.css";

const HEADER = 8; // [rms, peak, n_bands, n_wave, beat, flux, bpm, bpm_conf]
const PEAK_GRAVITY = 0.5; // units/s
const HUD_HIDE_MS = 5000;

const inTauri = "__TAURI_INTERNALS__" in window;

type MilkdropRuntime = {
  butterchurn: typeof import("butterchurn")["default"];
  presets: Record<string, unknown>;
};

let PRESETS: Record<string, unknown> = {};
let milkdropRuntime: MilkdropRuntime | null = null;
let milkdropRuntimePromise: Promise<MilkdropRuntime> | null = null;

function loadMilkdropRuntime(): Promise<MilkdropRuntime> {
  if (milkdropRuntime) return Promise.resolve(milkdropRuntime);
  if (milkdropRuntimePromise) return milkdropRuntimePromise;

  milkdropRuntimePromise = Promise.all([
    import("butterchurn"),
    import("butterchurn-presets"),
  ])
    .then(([butterchurnModule, presetModule]) => {
      // UMD interop: depending on the bundler path presets may be nested once
      // more under `default`.
      const rawPresets = presetModule.default as Record<string, unknown> & {
        default?: Record<string, unknown>;
      };
      const runtime = {
        butterchurn: butterchurnModule.default,
        presets: rawPresets.default ?? rawPresets,
      };
      PRESETS = runtime.presets;
      milkdropRuntime = runtime;
      return runtime;
    })
    .catch((error) => {
      milkdropRuntimePromise = null;
      throw error;
    });

  return milkdropRuntimePromise;
}

const PRESET_KEYS = [...getBasePresetKeys().presets].sort((a, b) =>
  a.localeCompare(b),
);

function flog(msg: string) {
  console.log(msg);
  // subsystem failures reported via flog belong in the debug HUD too
  if (/FAILED|error/i.test(msg)) noteError(msg);
  if (inTauri) invoke("frontend_log", { msg }).catch(() => {});
}

installErrorCapture();

type SourceInfo = {
  id: string;
  name: string;
  kind: "loopback" | "input";
  is_default: boolean;
};

type AppInfo = {
  pid: number;
  name: string;
  active: boolean;
};

type VizMode = "bars" | "radial" | "scope" | "milkdrop" | "3d";
const VIZ_MODES: VizMode[] = ["bars", "radial", "scope", "milkdrop", "3d"];
const VIZ_MODE_LABELS: Record<VizMode, string> = {
  bars: "Balken",
  radial: "Radial",
  scope: "Welle",
  milkdrop: "Milkdrop",
  "3d": "3D",
};

type BgLayer = "off" | "milkdrop" | "3d";
const BG_LAYERS: BgLayer[] = ["off", "milkdrop", "3d"];
const BLEND_MODES = ["screen", "lighten", "overlay", "normal"] as const;
type BlendMode = (typeof BLEND_MODES)[number];

function is2DMode(m: VizMode): boolean {
  return m === "bars" || m === "radial" || m === "scope";
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

function splitOnce(v: string, sep: string): [string, string] {
  const i = v.indexOf(sep);
  return [v.slice(0, i), v.slice(i + 1)];
}

type Persisted = {
  mode?: VizMode;
  scene3d?: SceneName;
  presetKey?: string;
  autoSwitch?: boolean;
  showBpm?: boolean;
  sourceValue?: string;
  modelId?: number;
  bgLayer?: BgLayer;
  blendMode?: BlendMode;
  debug?: boolean;
};

const SETTINGS_KEY = "vizzy.settings.v1";

const saved: Persisted = (() => {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Persisted;
  } catch {
    return {};
  }
})();

function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mdCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const gl3dCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const modeRef = useRef<VizMode>("bars");
  const presetKeyRef = useRef<string>(PRESET_KEYS[0] ?? "");
  const autoRef = useRef(false);
  const sceneRef = useRef<SceneName>("orb");
  const [mode, setMode] = useState<VizMode>(
    saved.mode && VIZ_MODES.includes(saved.mode) ? saved.mode : "bars",
  );
  const [userPresets, setUserPresets] = useState(loadUserPresets);
  const [presetKey, setPresetKey] = useState(() => {
    const k = saved.presetKey;
    if (!k) return PRESET_KEYS[0] ?? "";
    if (PRESET_KEYS.includes(k)) return k;
    if (
      k.startsWith("user:") &&
      loadUserPresets().some((p) => `user:${p.name}` === k)
    ) {
      return k;
    }
    return PRESET_KEYS[0] ?? "";
  });
  const [autoSwitch, setAutoSwitch] = useState(saved.autoSwitch ?? false);
  const [showBpm, setShowBpm] = useState(saved.showBpm ?? false);
  const [debugOpen, setDebugOpen] = useState(saved.debug ?? false);
  const debugElRef = useRef<HTMLPreElement | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const editorButtonRef = useRef<HTMLButtonElement | null>(null);
  const helpButtonRef = useRef<HTMLButtonElement | null>(null);
  const [bgLayer, setBgLayer] = useState<BgLayer>(
    saved.bgLayer && BG_LAYERS.includes(saved.bgLayer) ? saved.bgLayer : "off",
  );
  const [blendMode, setBlendMode] = useState<BlendMode>(
    saved.blendMode && BLEND_MODES.includes(saved.blendMode)
      ? saved.blendMode
      : "screen",
  );
  const bgLayerRef = useRef<BgLayer>("off");
  const blendRef = useRef<BlendMode>("screen");
  const bpmElRef = useRef<HTMLSpanElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const modelFileRef = useRef<ModelAction | null>(null);
  const camResetRef = useRef(0);
  const [models, setModels] = useState<ModelMeta[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<number | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [routingOpen, setRoutingOpen] = useState(false);
  const [tweakOpen, setTweakOpen] = useState(false);
  const [mdOverrides, setMdOverrides] = useState<Record<string, number>>({});
  const overridesRef = useRef({
    version: 0,
    map: {} as Record<string, number>,
  });
  const [scene3d, setScene3d] = useState<SceneName>(
    saved.scene3d && SCENE_NAMES.includes(saved.scene3d)
      ? saved.scene3d
      : "orb",
  );
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [selected, setSelected] = useState("");
  const [hudVisible, setHudVisible] = useState(true);
  const [milkdropStatus, setMilkdropStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >(milkdropRuntime ? "ready" : "idle");
  const hideTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    presetKeyRef.current = presetKey;
  }, [presetKey]);

  useEffect(() => {
    autoRef.current = autoSwitch;
  }, [autoSwitch]);

  useEffect(() => {
    sceneRef.current = scene3d;
  }, [scene3d]);

  useEffect(() => {
    bgLayerRef.current = bgLayer;
  }, [bgLayer]);

  useEffect(() => {
    blendRef.current = blendMode;
  }, [blendMode]);

  useEffect(() => {
    overridesRef.current = {
      version: overridesRef.current.version + 1,
      map: mdOverrides,
    };
  }, [mdOverrides]);

  // switching presets discards unsaved tweaks
  useEffect(() => {
    setMdOverrides({});
  }, [presetKey]);

  useEffect(() => {
    if (mode !== "milkdrop" && tweakOpen) setTweakOpen(false);
  }, [mode, tweakOpen]);

  const requestMilkdropRuntime = useCallback(async () => {
    if (milkdropRuntime) {
      setMilkdropStatus("ready");
      return;
    }
    setMilkdropStatus("loading");
    try {
      await loadMilkdropRuntime();
      setMilkdropStatus("ready");
    } catch (error) {
      setMilkdropStatus("error");
      flog(`[md] runtime load FAILED: ${error}`);
    }
  }, []);

  useEffect(() => {
    const needed =
      mode === "milkdrop" || bgLayer === "milkdrop" || tweakOpen;
    if (needed && milkdropStatus === "idle") {
      void requestMilkdropRuntime();
    }
  }, [
    mode,
    bgLayer,
    tweakOpen,
    milkdropStatus,
    requestMilkdropRuntime,
  ]);

  const resolvePreset = useCallback(
    (key: string): unknown | null => {
      if (key.startsWith("user:")) {
        const up = userPresets.find((p) => p.name === key.slice(5));
        if (!up) return null;
        const base = PRESETS[up.base];
        if (!base) return null;
        return mergeBaseVals(base, up.overrides);
      }
      return PRESETS[key] ?? null;
    },
    [userPresets, milkdropStatus],
  );
  const resolvePresetRef = useRef(resolvePreset);
  useEffect(() => {
    resolvePresetRef.current = resolvePreset;
  }, [resolvePreset]);

  const allPresetKeys = useMemo(
    () => [...userPresets.map((p) => `user:${p.name}`), ...PRESET_KEYS],
    [userPresets],
  );

  const currentBaseVals = useMemo(() => {
    const p = resolvePreset(presetKey) as {
      baseVals?: Record<string, unknown>;
    } | null;
    return p?.baseVals ?? {};
  }, [resolvePreset, presetKey]);

  const saveTweaks = useCallback(
    (name: string) => {
      const currentUser = presetKey.startsWith("user:")
        ? userPresets.find((p) => p.name === presetKey.slice(5))
        : undefined;
      const baseKey = currentUser?.base ?? presetKey;
      const list = saveUserPreset({
        name,
        base: baseKey,
        overrides: { ...(currentUser?.overrides ?? {}), ...mdOverrides },
      });
      setUserPresets(list);
      setPresetKey(`user:${name}`);
      flog(`[md] user preset saved: ${name}`);
    },
    [presetKey, userPresets, mdOverrides],
  );

  const removeUserPreset = useCallback(
    (name: string) => {
      const up = userPresets.find((p) => p.name === name);
      const list = deleteUserPreset(name);
      setUserPresets(list);
      if (presetKey === `user:${name}`) {
        setPresetKey(up && PRESETS[up.base] ? up.base : (PRESET_KEYS[0] ?? ""));
      }
    },
    [userPresets, presetKey],
  );

  const loadLists = useCallback(() => {
    if (!inTauri) return;
    invoke<SourceInfo[]>("list_sources")
      .then((list) => {
        setSources(list);
        const def = list.find((s) => s.kind === "loopback" && s.is_default);
        if (def) {
          setSelected((prev) => (prev === "" ? `loopback|${def.id}` : prev));
        }
      })
      .catch(console.error);
    invoke<AppInfo[]>("list_apps").then(setApps).catch(console.error);
  }, []);

  const selectSource = useCallback(async (value: string) => {
    setSelected(value);
    const [kind, rest] = splitOnce(value, "|");
    let spec: Record<string, unknown>;
    if (kind === "app") {
      const [pidStr, name] = splitOnce(rest, "|");
      spec = { kind, pid: Number(pidStr), name };
    } else {
      spec = { kind, device_id: rest };
    }
    try {
      await invoke("set_source", { spec });
    } catch (e) {
      console.error("set_source failed", e);
    }
  }, []);

  // On startup: load lists once and restore the persisted source. App
  // sources are re-matched by process name (PIDs change across reboots);
  // anything stale falls back to default loopback. Ref-guarded so React
  // StrictMode's double effect run doesn't queue two source switches.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (!inTauri || restoredRef.current) return;
    restoredRef.current = true;
    void (async () => {
      try {
        const [srcs, appList] = await Promise.all([
          invoke<SourceInfo[]>("list_sources"),
          invoke<AppInfo[]>("list_apps"),
        ]);
        setSources(srcs);
        setApps(appList);

        let value = "";
        const savedVal = saved.sourceValue;
        if (savedVal) {
          const [kind, rest] = splitOnce(savedVal, "|");
          if (kind === "app") {
            const [, name] = splitOnce(rest, "|");
            const match = appList.find((a) => a.name === name);
            if (match) value = `app|${match.pid}|${match.name}`;
          } else if (srcs.some((s) => `${s.kind}|${s.id}` === savedVal)) {
            value = savedVal;
          }
        }
        // sync persisted beat sensitivity into the Rust analyzer
        void invoke("set_beat_sensitivity", {
          sigma: params.get("audio", "beatSigma"),
        }).catch(console.error);

        if (value) {
          flog(`[cfg] restoring source: ${value.split("|")[0]}`);
          await selectSource(value);
        } else {
          const def = srcs.find((s) => s.kind === "loopback" && s.is_default);
          if (def) setSelected(`loopback|${def.id}`);
        }
      } catch (e) {
        console.error(e);
      }
    })();
  }, [selectSource]);

  // Persist settings on every change.
  useEffect(() => {
    const data: Persisted = {
      mode,
      scene3d,
      presetKey,
      autoSwitch,
      showBpm,
      sourceValue: selected,
      modelId: selectedModelId ?? undefined,
      bgLayer,
      blendMode,
      debug: debugOpen,
    };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
    } catch {
      // storage unavailable — not worth breaking the app over
    }
  }, [
    mode,
    scene3d,
    presetKey,
    autoSwitch,
    showBpm,
    selected,
    selectedModelId,
    bgLayer,
    blendMode,
    debugOpen,
  ]);

  const stepPreset = useCallback(
    (dir: number) => {
      setPresetKey((current) => {
        const i = allPresetKeys.indexOf(current);
        return allPresetKeys[
          (i + dir + allPresetKeys.length) % allPresetKeys.length
        ];
      });
    },
    [allPresetKeys],
  );

  const randomPreset = useCallback(() => {
    setPresetKey(
      allPresetKeys[Math.floor(Math.random() * allPresetKeys.length)],
    );
  }, [allPresetKeys]);

  const nextModelSeq = useCallback(
    () => (modelFileRef.current?.seq ?? 0) + 1,
    [],
  );

  const refreshModels = useCallback(() => {
    listModels().then(setModels).catch(console.error);
  }, []);

  const onModelFile = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = ""; // allow re-picking the same file
      if (!file) return;
      const data = await file.arrayBuffer();
      modelFileRef.current = {
        action: "load",
        data,
        name: file.name,
        seq: nextModelSeq(),
      };
      setScene3d("model");
      try {
        const id = await addModel(file.name, data);
        setSelectedModelId(id);
        refreshModels();
        flog(`[cfg] model saved: ${file.name} (#${id})`);
        // render a library preview in the background
        try {
          const { loadModelObject, renderModelThumb } = await import(
            "./modelLoader"
          );
          const obj = await loadModelObject(data, file.name);
          await updateThumb(id, renderModelThumb(obj));
          refreshModels();
        } catch {
          // preview is optional — the card shows a fallback icon
        }
      } catch (err) {
        flog(`[cfg] model save FAILED: ${err}`);
      }
    },
    [nextModelSeq, refreshModels],
  );

  const pickModel = useCallback(
    async (id: number | null) => {
      if (id == null) {
        setSelectedModelId(null);
        modelFileRef.current = { action: "clear", seq: nextModelSeq() };
        return;
      }
      try {
        const record = await getModel(id);
        if (!record) return;
        setSelectedModelId(id);
        modelFileRef.current = {
          action: "load",
          data: record.data,
          name: record.name,
          seq: nextModelSeq(),
        };
      } catch (err) {
        flog(`[cfg] model pick FAILED: ${err}`);
      }
    },
    [nextModelSeq],
  );

  const removeModel = useCallback(
    async (id: number) => {
      try {
        await deleteModel(id);
      } catch (err) {
        flog(`[cfg] model delete FAILED: ${err}`);
      }
      if (selectedModelId === id) {
        setSelectedModelId(null);
        modelFileRef.current = { action: "clear", seq: nextModelSeq() };
      }
      refreshModels();
    },
    [selectedModelId, nextModelSeq, refreshModels],
  );

  // Restore the model library + last selection (also in browser demo mode).
  const modelRestoredRef = useRef(false);
  useEffect(() => {
    if (modelRestoredRef.current) return;
    modelRestoredRef.current = true;
    void (async () => {
      try {
        const list = await listModels();
        setModels(list);
        const id = saved.modelId;
        if (id != null && list.some((m) => m.id === id)) {
          const record = await getModel(id);
          if (record) {
            setSelectedModelId(id);
            modelFileRef.current = {
              action: "load",
              data: record.data,
              name: record.name,
              seq: nextModelSeq(),
            };
            flog(`[cfg] restored model: ${record.name}`);
          }
        }
      } catch {
        // library unavailable — placeholder stays
      }
    })();
  }, [nextModelSeq]);

  // Emergency exit: wipe settings, parameters and the model library.
  const resetAll = useCallback(() => {
    try {
      localStorage.removeItem(SETTINGS_KEY);
      localStorage.removeItem(PARAMS_STORAGE_KEY);
    } catch {
      // ignore — reload restores defaults either way
    }
    void clearAllModels()
      .catch(() => {})
      .finally(() => window.location.reload());
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const mdCanvas = mdCanvasRef.current;
    const gl3dCanvas = gl3dCanvasRef.current;
    if (!canvas || !mdCanvas || !gl3dCanvas) return;
    return startVisualizer(
      canvas,
      mdCanvas,
      gl3dCanvas,
      modeRef,
      presetKeyRef,
      autoRef,
      sceneRef,
      randomPreset,
      bpmElRef,
      modelFileRef,
      camResetRef,
      bgLayerRef,
      blendRef,
      overridesRef,
      resolvePresetRef,
      debugElRef,
    );
  }, [randomPreset]);

  const toggleFullscreen = useCallback(async () => {
    if (inTauri) {
      const win = getCurrentWindow();
      await win.setFullscreen(!(await win.isFullscreen()));
    } else if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }
  }, []);

  const hudPinned =
    editorOpen ||
    helpOpen ||
    libraryOpen ||
    routingOpen ||
    (tweakOpen && mode === "milkdrop");

  const pokeHud = useCallback(() => {
    setHudVisible(true);
    window.clearTimeout(hideTimer.current);
    if (hudPinned) return;
    hideTimer.current = window.setTimeout(
      () => {
        if (!document.querySelector(".hud:focus-within")) {
          setHudVisible(false);
        }
      },
      HUD_HIDE_MS,
    );
  }, [hudPinned]);

  useEffect(() => {
    pokeHud();
    return () => window.clearTimeout(hideTimer.current);
  }, [pokeHud]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      pokeHud();
      const key = e.key.toLowerCase();

      if (e.key === "Escape") {
        if (libraryOpen) setLibraryOpen(false);
        else if (routingOpen) setRoutingOpen(false);
        else if (tweakOpen) setTweakOpen(false);
        else if (editorOpen) setEditorOpen(false);
        else if (helpOpen) setHelpOpen(false);
        else if (inTauri) void getCurrentWindow().setFullscreen(false);
        return;
      }

      // Modal dialogs own the keyboard until they are dismissed. Prevent
      // shortcuts from changing the app behind their backdrop.
      if (libraryOpen || routingOpen) return;

      // Global shortcuts must never fire while somebody is typing or using a
      // native select/range control.
      if (isEditableTarget(e.target)) return;

      if (key === "f" || e.key === "F11") {
        e.preventDefault();
        void toggleFullscreen();
      } else if (key === "e") {
        setEditorOpen((v) => !v);
        setRoutingOpen(false);
        setHelpOpen(false);
      } else if (key === "b") {
        setShowBpm((v) => !v);
      } else if (key === "d") {
        setDebugOpen((v) => !v);
      } else if (key === "?") {
        setHelpOpen((v) => !v);
        setEditorOpen(false);
        setRoutingOpen(false);
      } else if (e.key >= "1" && e.key <= String(VIZ_MODES.length)) {
        setMode(VIZ_MODES[Number(e.key) - 1]);
      } else if (modeRef.current === "milkdrop") {
        if (e.key === "ArrowRight") stepPreset(1);
        else if (e.key === "ArrowLeft") stepPreset(-1);
        else if (key === "r") randomPreset();
        else if (key === "a") setAutoSwitch((v) => !v);
      } else if (modeRef.current === "3d") {
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          setScene3d((s) => {
            const i = SCENE_NAMES.indexOf(s);
            const dir = e.key === "ArrowRight" ? 1 : -1;
            return SCENE_NAMES[
              (i + dir + SCENE_NAMES.length) % SCENE_NAMES.length
            ];
          });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    toggleFullscreen,
    stepPreset,
    randomPreset,
    libraryOpen,
    routingOpen,
    tweakOpen,
    editorOpen,
    helpOpen,
    pokeHud,
  ]);

  const loopbacks = sources.filter((s) => s.kind === "loopback");
  const inputs = sources.filter((s) => s.kind === "input");
  const controlsVisible = hudVisible || hudPinned;

  return (
    <div
      className={`stage mode-${mode} ${
        is2DMode(mode) && bgLayer !== "off" ? `bg-${bgLayer}` : ""
      } ${controlsVisible ? "" : "idle"}`}
      onPointerMove={pokeHud}
      onPointerDown={pokeHud}
      onKeyDownCapture={pokeHud}
      onFocusCapture={pokeHud}
      onBlurCapture={pokeHud}
    >
      <canvas ref={mdCanvasRef} id="mdviz" aria-hidden="true" />
      <canvas ref={gl3dCanvasRef} id="viz3d" aria-hidden="true" />
      <canvas ref={canvasRef} id="viz" aria-hidden="true" />
      <div className="sr-only" aria-live="polite">
        Aktive Visualisierung: {VIZ_MODE_LABELS[mode]}
      </div>
      {debugOpen && <pre className="debug-hud" ref={debugElRef} />}
      <div
        className={`hud ${controlsVisible ? "" : "hidden"}`}
        role="toolbar"
        aria-label="Vizzy-Steuerung"
      >
        <div className="hud-row">
          <span className="brand">VIZZY</span>
          {inTauri ? (
            <select
              className="src-select"
              value={selected}
              onChange={(e) => selectSource(e.target.value)}
              onPointerDown={loadLists}
              title="Audio-Quelle"
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
                {apps.map((a) => (
                  <option key={`app-${a.pid}`} value={`app|${a.pid}|${a.name}`}>
                    {a.active ? "♪ " : ""}
                    {a.name} (PID {a.pid})
                  </option>
                ))}
              </optgroup>
            </select>
          ) : (
            <span className="demo-tag">Demo</span>
          )}
          <span className="hud-spacer" />
          {showBpm && (
            <span
              className="bpm-badge"
              ref={bpmElRef}
              title="Geschätztes Tempo"
            >
              · · ·
            </span>
          )}
          {VIZ_MODES.map((m, i) => (
            <button
              key={m}
              type="button"
              className={`mode-btn ${mode === m ? "active" : ""}`}
              onClick={() => setMode(m)}
              title={`${VIZ_MODE_LABELS[m]} · Taste ${i + 1}`}
              aria-label={`Visualisierung: ${VIZ_MODE_LABELS[m]}`}
              aria-pressed={mode === m}
              aria-keyshortcuts={String(i + 1)}
            >
              {VIZ_MODE_LABELS[m]}
            </button>
          ))}
          <button
            type="button"
            className={`mode-btn ${showBpm ? "active" : ""}`}
            onClick={() => setShowBpm((v) => !v)}
            title="BPM-Anzeige (B)"
            aria-label="Tempoanzeige ein- oder ausblenden"
            aria-pressed={showBpm}
            aria-keyshortcuts="B"
          >
            Tempo
          </button>
          <button
            type="button"
            className={`mode-btn ${routingOpen ? "active" : ""}`}
            onClick={() => {
              setRoutingOpen((v) => !v);
              setEditorOpen(false);
              setHelpOpen(false);
            }}
            title="Frequenz-Listener & Routing"
            aria-label="Frequenz-Routing öffnen"
            aria-pressed={routingOpen}
            aria-controls="routing-dialog"
          >
            Routing
          </button>
          <button
            ref={editorButtonRef}
            type="button"
            className={`mode-btn ${editorOpen ? "active" : ""}`}
            onClick={() => {
              setEditorOpen((v) => !v);
              setRoutingOpen(false);
              setHelpOpen(false);
            }}
            title="Parameter-Editor (E)"
            aria-label="Parameter öffnen"
            aria-pressed={editorOpen}
            aria-controls="parameter-panel"
            aria-keyshortcuts="E"
          >
            Parameter
          </button>
          <button
            type="button"
            className="mode-btn"
            onClick={() => void toggleFullscreen()}
            title="Fullscreen (F)"
            aria-label="Vollbild umschalten"
            aria-keyshortcuts="F"
          >
            Vollbild
          </button>
          <button
            ref={helpButtonRef}
            type="button"
            className={`mode-btn ${helpOpen ? "active" : ""}`}
            onClick={() => {
              setHelpOpen((v) => !v);
              setEditorOpen(false);
              setRoutingOpen(false);
            }}
            title="Hilfe & Tastenkürzel (?)"
            aria-label="Hilfe und Tastenkürzel öffnen"
            aria-pressed={helpOpen}
            aria-controls="help-panel"
            aria-keyshortcuts="?"
          >
            Hilfe
          </button>
        </div>
        {is2DMode(mode) && (
          <div className="hud-row hud-sub">
            <span className="demo-tag">Layer:</span>
            {BG_LAYERS.map((l) => (
              <button
                key={l}
                type="button"
                className={`mode-btn ${bgLayer === l ? "active" : ""}`}
                onClick={() => setBgLayer(l)}
                title="Hintergrund-Layer unter der 2D-Visualization"
                aria-pressed={bgLayer === l}
              >
                {l === "off" ? "aus" : l}
              </button>
            ))}
            {bgLayer !== "off" && (
              <button
                type="button"
                className="mode-btn"
                onClick={() =>
                  setBlendMode(
                    BLEND_MODES[
                      (BLEND_MODES.indexOf(blendMode) + 1) % BLEND_MODES.length
                    ],
                  )
                }
                title="Blend-Modus des Vordergrunds"
              >
                ⊕ {blendMode}
              </button>
            )}
            {bgLayer === "milkdrop" &&
              (milkdropStatus === "idle" ||
                milkdropStatus === "loading") && (
                <span className="feature-status" role="status">
                  Milkdrop wird geladen…
                </span>
              )}
            {bgLayer === "milkdrop" && milkdropStatus === "error" && (
              <button
                type="button"
                className="mode-btn danger"
                onClick={() => void requestMilkdropRuntime()}
              >
                Milkdrop erneut laden
              </button>
            )}
          </div>
        )}
        {mode === "milkdrop" && (
          <div className="hud-row hud-sub">
            <button
              type="button"
              className="mode-btn"
              onClick={() => stepPreset(-1)}
              title="Vorheriges Preset (←)"
              aria-label="Vorheriges Preset"
            >
              Zurück
            </button>
            <select
              className="src-select preset-select"
              value={presetKey}
              onChange={(e) => setPresetKey(e.target.value)}
              title={presetKey}
              aria-label="Milkdrop-Preset"
            >
              {userPresets.length > 0 && (
                <optgroup label="Eigene Presets">
                  {userPresets.map((p) => (
                    <option key={`user:${p.name}`} value={`user:${p.name}`}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="Butterchurn">
                {PRESET_KEYS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </optgroup>
            </select>
            <button
              type="button"
              className="mode-btn"
              onClick={() => stepPreset(1)}
              title="Nächstes Preset (→)"
              aria-label="Nächstes Preset"
            >
              Weiter
            </button>
            <button
              type="button"
              className="mode-btn"
              onClick={randomPreset}
              title="Zufälliges Preset (R)"
              aria-label="Zufälliges Preset"
              aria-keyshortcuts="R"
            >
              Zufall
            </button>
            <button
              type="button"
              className={`mode-btn ${autoSwitch ? "active" : ""}`}
              onClick={() => setAutoSwitch((v) => !v)}
              title="Auto-Wechsel bei Beats (A)"
              aria-label="Automatischen Preset-Wechsel umschalten"
              aria-pressed={autoSwitch}
              aria-keyshortcuts="A"
            >
              auto
            </button>
            <button
              type="button"
              className={`mode-btn ${tweakOpen ? "active" : ""}`}
              onClick={() => setTweakOpen((v) => !v)}
              title="Preset-Tweaks — verbiegen & als eigenes Preset speichern"
              aria-label="Preset-Tweaks öffnen"
              aria-pressed={tweakOpen}
              aria-controls="tweak-panel"
            >
              Tweaks
            </button>
            {(milkdropStatus === "idle" ||
              milkdropStatus === "loading") && (
              <span className="feature-status" role="status">
                Milkdrop wird geladen…
              </span>
            )}
            {milkdropStatus === "error" && (
              <button
                type="button"
                className="mode-btn danger"
                onClick={() => void requestMilkdropRuntime()}
              >
                Erneut laden
              </button>
            )}
          </div>
        )}
        {mode === "3d" && (
          <div className="hud-row hud-sub">
            {SCENE_NAMES.map((s) => (
              <button
                key={s}
                type="button"
                className={`mode-btn ${scene3d === s ? "active" : ""}`}
                onClick={() => setScene3d(s)}
                title="Szene (←/→)"
                aria-pressed={scene3d === s}
              >
                {s}
              </button>
            ))}
            <button
              type="button"
              className="mode-btn"
              onClick={() => {
                camResetRef.current += 1;
              }}
              title="Kamera zurücksetzen (auch: Doppelklick) — Maus: ziehen = kreisen, Rad = zoomen, rechts = verschieben"
            >
              Kamera zurücksetzen
            </button>
            {scene3d === "model" && (
              <button
                type="button"
                className="mode-btn lib-btn"
                onClick={() => {
                  refreshModels();
                  setLibraryOpen(true);
                }}
                title="Modell-Library öffnen"
            >
                Modell: {" "}
                {selectedModelId != null
                  ? (models.find((m) => m.id === selectedModelId)?.name ??
                    "Library")
                  : "Library"}
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept=".glb,.gltf,.zip"
              style={{ display: "none" }}
              onChange={onModelFile}
            />
          </div>
        )}
      </div>
      {editorOpen && (
        <EditorPanel
          groups={[
            "audio",
            "render",
            ...(is2DMode(mode) && bgLayer !== "off" ? ["layer"] : []),
            mode === "3d" ? scene3d : mode,
          ]}
          onClose={() => setEditorOpen(false)}
          onResetAll={resetAll}
          returnFocusRef={editorButtonRef}
        />
      )}
      {helpOpen && (
        <HelpPanel
          onClose={() => setHelpOpen(false)}
          returnFocusRef={helpButtonRef}
        />
      )}
      {libraryOpen && (
        <LibraryModal
          models={models}
          selectedId={selectedModelId}
          onPick={(id) => void pickModel(id)}
          onDelete={(id) => void removeModel(id)}
          onAdd={() => fileInputRef.current?.click()}
          onClose={() => setLibraryOpen(false)}
        />
      )}
      {routingOpen && <RoutingModal onClose={() => setRoutingOpen(false)} />}
      {tweakOpen && mode === "milkdrop" && (
        <MdTweakPanel
          presetKey={presetKey}
          baseVals={currentBaseVals}
          overrides={mdOverrides}
          onChange={(key, value) =>
            setMdOverrides((prev) => ({ ...prev, [key]: value }))
          }
          onReset={() => setMdOverrides({})}
          onSave={saveTweaks}
          onDeleteUser={removeUserPreset}
          onClose={() => setTweakOpen(false)}
        />
      )}
    </div>
  );
}

function startVisualizer(
  canvas: HTMLCanvasElement,
  mdCanvas: HTMLCanvasElement,
  gl3dCanvas: HTMLCanvasElement,
  modeRef: { current: VizMode },
  presetKeyRef: { current: string },
  autoRef: { current: boolean },
  sceneRef: { current: SceneName },
  onAutoSwitch: () => void,
  bpmEl: { current: HTMLSpanElement | null },
  modelRef: { current: ModelAction | null },
  camResetRef: { current: number },
  bgLayerRef: { current: BgLayer },
  blendRef: { current: BlendMode },
  overridesRef: { current: { version: number; map: Record<string, number> } },
  resolveRef: { current: (key: string) => unknown | null },
  debugEl: { current: HTMLPreElement | null },
): () => void {
  const ctx = canvas.getContext("2d")!;

  let running = true;
  let raf = 0;

  // latest backend data
  let bands = new Float32Array(64);
  let wave = new Float32Array(1024);
  let rms = 0;
  let peak = 0;
  let flux = 0;
  let beat = 0;
  let bpm = 0;
  let bpmConf = 0;
  let prevBeat = 0;
  let lastAutoSwitch = 0;

  // smoothed display state
  let disp = new Float32Array(bands.length);
  let peaks = new Float32Array(bands.length);

  // 3D state (lazy)
  let viz3d: Viz3D | null = null;
  let viz3dLoading: Promise<void> | null = null;
  let viz3dFailed = false;
  let loadedModelSeq = 0;
  let lastCamReset = 0;

  function ensure3D(): boolean {
    if (viz3d) return true;
    if (viz3dFailed) return false;
    if (gl3dCanvas.clientWidth === 0 || gl3dCanvas.clientHeight === 0) {
      return false;
    }
    if (!viz3dLoading) {
      viz3dLoading = import("./scenes3d")
        .then(({ Viz3D: Viz3DClass }) => {
          if (!running) return;
          viz3d = new Viz3DClass(gl3dCanvas, sceneRef.current, flog);
          flog(
            `[3d] renderer init ok, ${gl3dCanvas.width}x${gl3dCanvas.height}`,
          );
        })
        .catch((e) => {
          viz3dFailed = true;
          flog(`[3d] renderer init FAILED: ${e}`);
        });
    }
    return false;
  }

  function render3D(dt: number, t: number) {
    if (!ensure3D() || !viz3d) return;
    try {
      const m = modelRef.current;
      if (m && m.seq !== loadedModelSeq) {
        loadedModelSeq = m.seq;
        if (m.action === "load") viz3d.loadModel(m.data, m.name);
        else viz3d.clearModel();
      }
      if (camResetRef.current !== lastCamReset) {
        lastCamReset = camResetRef.current;
        viz3d.resetCamera();
      }
      viz3d.setScene(sceneRef.current);
      viz3d.render({ disp, wave, rms, beat, dt, t });
    } catch (e) {
      viz3dFailed = true;
      flog(`[3d] render FAILED: ${e}`);
    }
  }

  // butterchurn state (lazy)
  let bc: BCVisualizer | null = null;
  let bcRuntimeLoading: Promise<void> | null = null;
  let bcRuntimeFailed = false;
  let bcAudioCtx: AudioContext | null = null;
  let bcFailed = false;
  let bcLoadedPreset = "";
  let bcLoadedOvVersion = -1;
  let bcEverLoaded = false;
  let lastTweakApply = 0;
  const timeByte = new Uint8Array(1024).fill(128);

  function ensureButterchurn(): boolean {
    if (bc) return true;
    if (bcFailed) return false;
    if (mdCanvas.clientWidth === 0 || mdCanvas.clientHeight === 0) {
      return false; // layout not ready yet — retry next frame
    }
    if (!milkdropRuntime) {
      if (bcRuntimeFailed) return false;
      if (!bcRuntimeLoading) {
        bcRuntimeLoading = loadMilkdropRuntime()
          .then(() => undefined)
          .catch((error) => {
            bcRuntimeFailed = true;
            flog(`[md] runtime load FAILED: ${error}`);
          });
      }
      return false;
    }
    bcRuntimeFailed = false;
    try {
      bcAudioCtx = new AudioContext();
      bc = milkdropRuntime.butterchurn.createVisualizer(bcAudioCtx, mdCanvas, {
        width: mdCanvas.width,
        height: mdCanvas.height,
      });
      flog(
        `[md] butterchurn init ok, ${PRESET_KEYS.length} presets, ` +
          `${mdCanvas.width}x${mdCanvas.height}`,
      );
      return true;
    } catch (e) {
      bcFailed = true;
      if (bcAudioCtx) void bcAudioCtx.close();
      bcAudioCtx = null;
      flog(`[md] butterchurn init FAILED: ${e}`);
      return false;
    }
  }

  function renderMilkdrop() {
    if (!ensureButterchurn() || !bc) return;
    if (mdCanvas.width === 0 || mdCanvas.height === 0) return;

    // beat-driven auto preset switching (rising edge + cooldown)
    if (autoRef.current && beat >= 0.95 && prevBeat < 0.95) {
      const nowMs = performance.now();
      if (nowMs - lastAutoSwitch > params.get("milkdrop", "cooldown") * 1000) {
        lastAutoSwitch = nowMs;
        onAutoSwitch();
      }
    }
    prevBeat = beat;

    const want = presetKeyRef.current;
    const ov = overridesRef.current;
    if (want !== bcLoadedPreset || ov.version !== bcLoadedOvVersion) {
      const keyChanged = want !== bcLoadedPreset;
      const nowMs = performance.now();
      // live tweaks re-load the preset — rate-limited so slider drags
      // don't rebuild the pipeline on every pixel
      if (keyChanged || nowMs - lastTweakApply > 150) {
        lastTweakApply = nowMs;
        const base = resolveRef.current(want);
        bcLoadedPreset = want;
        bcLoadedOvVersion = ov.version;
        if (base) {
          try {
            const preset = Object.keys(ov.map).length
              ? mergeBaseVals(base, ov.map)
              : base;
            bc.loadPreset(
              preset,
              keyChanged && bcEverLoaded
                ? params.get("milkdrop", "blend")
                : 0,
            );
            bcEverLoaded = true;
            if (keyChanged) flog(`[md] preset: ${want}`);
          } catch (e) {
            flog(`[md] loadPreset FAILED (${want}): ${e}`);
          }
        }
      }
    }

    // sensitivity applies to the waveform butterchurn analyzes, too
    const gain = params.get("audio", "gain");
    const n = Math.min(wave.length, timeByte.length);
    for (let j = 0; j < n; j++) {
      const v = Math.max(-1, Math.min(1, wave[j] * gain));
      timeByte[j] = (v * 127 + 128) | 0;
    }
    try {
      bc.render({
        audioLevels: {
          timeByteArray: timeByte,
          timeByteArrayL: timeByte,
          timeByteArrayR: timeByte,
        },
      });
    } catch (e) {
      bcFailed = true;
      flog(`[md] render FAILED: ${e}`);
    }
  }

  let fetching = false;
  let ipcMs = 0; // smoothed get_analysis_frame round-trip
  let ipcErrs = 0;
  async function fetchFrame() {
    if (fetching) return;
    fetching = true;
    const t0 = performance.now();
    try {
      const buf = await invoke<ArrayBuffer>("get_analysis_frame");
      ipcMs = ipcMs * 0.95 + (performance.now() - t0) * 0.05;
      const f = new Float32Array(buf);
      const nBands = f[2] | 0;
      const nWave = f[3] | 0;
      rms = f[0];
      peak = f[1];
      beat = f[4];
      flux = f[5];
      bpm = f[6];
      bpmConf = f[7];
      bands = f.subarray(HEADER, HEADER + nBands);
      wave = f.subarray(HEADER + nBands, HEADER + nBands + nWave);
      if (disp.length !== nBands) {
        disp = new Float32Array(nBands);
        peaks = new Float32Array(nBands);
      }
    } catch (e) {
      // single missed frame is fine — but count it for the debug HUD
      if (++ipcErrs === 1) noteError(`get_analysis_frame: ${e}`);
    } finally {
      fetching = false;
    }
  }

  // Animated fake data so the plain-browser preview (no Tauri IPC) shows life.
  function mockFrame(t: number) {
    for (let i = 0; i < bands.length; i++) {
      const base = Math.pow(1 - i / bands.length, 0.7);
      const a = 0.5 + 0.5 * Math.sin(t * 1.7 + i * 0.42);
      const b = 0.5 + 0.5 * Math.sin(t * 3.3 + i * 0.11 + 1.4);
      bands[i] = base * (0.18 + 0.6 * a * b);
    }
    for (let j = 0; j < wave.length; j++) {
      wave[j] =
        0.28 * Math.sin(j * 0.055 + t * 7) +
        0.18 * Math.sin(j * 0.013 + t * 2.6);
    }
    rms = 0.2 + 0.1 * Math.sin(t * 2.2);
    peak = rms * 2.2;
    beat = Math.pow(0.5 + 0.5 * Math.sin(t * 4.2), 12);
    flux = beat * 0.7;
    bpm = 128;
    bpmConf = 0.9;
  }

  let gradient: CanvasGradient | null = null;
  /** devicePixelRatio scaled by the render-resolution setting: every canvas
   *  bitmap is sized with this, CSS stretches it to full window size. */
  function effectiveDpr() {
    const scale = params.get("render", "scale") / 100;
    return (window.devicePixelRatio || 1) * scale;
  }
  function resize() {
    const dpr = effectiveDpr();
    if (canvas.clientWidth === 0 || canvas.clientHeight === 0) {
      // mid-fullscreen-transition layout — a 0-sized setRendererSize would
      // corrupt butterchurn's framebuffers (black picture until preset load)
      return;
    }
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
    mdCanvas.width = Math.round(mdCanvas.clientWidth * dpr);
    mdCanvas.height = Math.round(mdCanvas.clientHeight * dpr);
    bc?.setRendererSize(mdCanvas.width, mdCanvas.height);
    const w3 = Math.round(gl3dCanvas.clientWidth * dpr);
    const h3 = Math.round(gl3dCanvas.clientHeight * dpr);
    if (viz3d) {
      viz3d.resize(w3, h3); // sets the canvas bitmap size via three
    } else {
      gl3dCanvas.width = w3;
      gl3dCanvas.height = h3;
    }
    gradient = ctx.createLinearGradient(0, canvas.height, 0, 0);
    gradient.addColorStop(0.0, "#38bdf8");
    gradient.addColorStop(0.45, "#818cf8");
    gradient.addColorStop(0.8, "#e879f9");
    gradient.addColorStop(1.0, "#fb7185");
    ctx.fillStyle = "#07070c";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  window.addEventListener("resize", resize);
  resize();

  let last = performance.now();
  // fps = rendered frames per 1s window. Counting is the honest metric here:
  // an EMA over 1/dt systematically overestimates under the FPS limiter,
  // because vsync quantizes the intervals (16/33/50 ms mix).
  let fps = 60;
  let fpsFrames = 0;
  let fpsWindowStart = last;

  // CSS compositing between the stacked canvases; only touched on change.
  let lastLayerCss = "";
  function applyLayerStyles(is2D: boolean) {
    const bg = is2D ? bgLayerRef.current : "off";
    const blur = params.get("layer", "blur");
    const dim = params.get("layer", "dim");
    const opacity = params.get("layer", "opacity");
    const blend = blendRef.current;
    const key = `${bg}|${blur}|${dim}|${opacity}|${blend}`;
    if (key === lastLayerCss) return;
    lastLayerCss = key;

    mdCanvas.style.filter = "";
    gl3dCanvas.style.filter = "";
    if (bg === "off") {
      canvas.style.mixBlendMode = "";
      canvas.style.opacity = "";
      return;
    }
    const bgEl = bg === "milkdrop" ? mdCanvas : gl3dCanvas;
    bgEl.style.filter = `blur(${blur}px) brightness(${dim})`;
    canvas.style.mixBlendMode = blend;
    canvas.style.opacity = String(opacity);
  }

  let nextFrameAt = 0;
  function frame(now: number) {
    if (!running) return;

    // FPS limiter: skip rAF ticks until the next slot. Schedule-based
    // (+step, not now+step) so the average rate stays exact despite rAF
    // jitter; the max() stops catch-up bursts after tab-hidden stretches.
    const cap = params.get("render", "fpsCap");
    if (cap < 118) {
      if (now < nextFrameAt) {
        raf = requestAnimationFrame(frame);
        return;
      }
      nextFrameAt = Math.max(nextFrameAt + 1000 / cap, now);
    }

    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    fpsFrames++;
    const fpsElapsed = now - fpsWindowStart;
    if (fpsElapsed >= 1000) {
      // >2s without ticks = tab was hidden (rAF suspended) — discard that
      // window instead of reporting a bogus near-zero rate.
      if (fpsElapsed < 2000) fps = (fpsFrames * 1000) / fpsElapsed;
      fpsFrames = 0;
      fpsWindowStart = now;
    }

    // Layout/dpr/render-scale can change without a window resize event (e.g.
    // CSS landing after init, editor slider) — cheap per-frame check keeps
    // bitmap sizes in sync.
    const dprNow = effectiveDpr();
    if (
      canvas.width !== Math.round(canvas.clientWidth * dprNow) ||
      canvas.height !== Math.round(canvas.clientHeight * dprNow)
    ) {
      resize();
    }

    if (inTauri) fetchFrame();
    else mockFrame(now / 1000);

    // frequency listeners → parameter modulation
    routing.update(bands, dt);

    const gain = params.get("audio", "gain");
    const attackTau = params.get("audio", "attack") / 1000;
    const releaseTau = params.get("audio", "release") / 1000;
    const attack = 1 - Math.exp(-dt / attackTau);
    const release = 1 - Math.exp(-dt / releaseTau);
    for (let i = 0; i < disp.length; i++) {
      const target = Math.min(1, bands[i] * gain);
      disp[i] += (target - disp[i]) * (target > disp[i] ? attack : release);
      peaks[i] = Math.max(peaks[i] - PEAK_GRAVITY * dt, disp[i]);
    }

    if (modeRef.current === "milkdrop") {
      renderMilkdrop();
    } else if (modeRef.current === "3d") {
      render3D(dt, now / 1000);
    } else {
      // layered background under the 2D visualization
      if (bgLayerRef.current === "milkdrop") renderMilkdrop();
      else if (bgLayerRef.current === "3d") render3D(dt, now / 1000);
      draw();
    }
    applyLayerStyles(is2DMode(modeRef.current));

    const el = bpmEl.current;
    if (el) {
      const text =
        bpmConf > 0.3 && bpm > 40 ? `${Math.round(bpm)} BPM` : "· · ·";
      if (el.textContent !== text) el.textContent = text;
      el.style.transform = `scale(${(1 + beat * 0.15).toFixed(3)})`;
    }

    updateDebugHud(now, cap);

    raf = requestAnimationFrame(frame);
  }

  // Debug HUD (key: D) — written straight to the DOM at 4 Hz, same pattern
  // as the BPM badge: no React involvement in the render loop.
  let nextDebugAt = 0;
  function updateDebugHud(now: number, cap: number) {
    const el = debugEl.current;
    if (!el || now < nextDebugAt) return;
    nextDebugAt = now + 250;

    const scale = params.get("render", "scale");
    const mode = modeRef.current;
    const lines = [
      `${fps.toFixed(1)} fps · ${(1000 / Math.max(fps, 0.1)).toFixed(1)} ms` +
        (cap < 118 ? ` · cap ${cap}` : ""),
      `2d ${canvas.width}×${canvas.height} · md ${mdCanvas.width}×${mdCanvas.height} · 3d ${gl3dCanvas.width}×${gl3dCanvas.height}`,
      `scale ${scale}% · dpr ${(window.devicePixelRatio || 1).toFixed(2)} · ` +
        `mode ${mode}${mode === "3d" ? `:${sceneRef.current}` : ""}`,
      inTauri
        ? `ipc ${ipcMs.toFixed(2)} ms · ipc-errors ${ipcErrs}`
        : "ipc — (browser-demo, mock data)",
      `rms ${rms.toFixed(3)} · peak ${peak.toFixed(3)} · flux ${flux.toFixed(2)} · beat ${beat.toFixed(2)}`,
      `bpm ${bpm.toFixed(1)} · conf ${bpmConf.toFixed(2)}`,
    ];
    if (debugErrors.length) {
      lines.push("", "— letzte Fehler —", ...debugErrors);
    }
    const text = lines.join("\n");
    if (el.textContent !== text) el.textContent = text;
  }

  function draw() {
    const w = canvas.width;
    const h = canvas.height;
    // effective dpr: keeps text/line thickness visually constant when the
    // bitmap is downscaled and CSS stretches it back up
    const dpr = effectiveDpr();

    // translucent clear → motion trails (lower alpha = longer trails)
    const trail = params.get(modeRef.current, "trail") || 0.35;
    ctx.fillStyle = `rgba(7, 7, 12, ${trail.toFixed(2)})`;
    ctx.fillRect(0, 0, w, h);

    // subtle beat flash
    if (beat > 0.05) {
      ctx.fillStyle = `rgba(129, 140, 248, ${(beat * 0.06).toFixed(3)})`;
      ctx.fillRect(0, 0, w, h);
    }

    switch (modeRef.current) {
      case "bars":
        drawBars(w, h);
        break;
      case "radial":
        drawRadial(w, h);
        break;
      case "scope":
        drawScope(w, h, dpr);
        break;
      case "milkdrop":
        break;
    }

    // HUD text bottom-right
    ctx.font = `${11 * dpr}px ui-monospace, Consolas, monospace`;
    ctx.fillStyle = "rgba(226, 232, 240, 0.55)";
    ctx.textBaseline = "bottom";
    ctx.textAlign = "right";
    ctx.fillText(
      `${fps.toFixed(0)} fps  rms ${rms.toFixed(3)}`,
      w - 12 * dpr,
      h - 10 * dpr,
    );
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
  }

  function drawBars(w: number, h: number) {
    const n = disp.length;
    const gap = Math.max(1, w * 0.0025);
    const bw = (w - gap * (n + 1)) / n;
    const maxBar = h * params.get("bars", "height");

    ctx.fillStyle = gradient!;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const bh = disp[i] * maxBar;
      if (bh < 1) continue;
      const x = gap + i * (bw + gap);
      const r = Math.min(bw * 0.35, bh / 2);
      ctx.roundRect(x, h - bh, bw, bh, [r, r, 0, 0]);
    }
    ctx.fill();

    ctx.fillStyle = "rgba(248, 250, 252, 0.65)";
    const capH = Math.max(1.5, h * 0.003);
    for (let i = 0; i < n; i++) {
      if (peaks[i] * maxBar < 2) continue;
      const x = gap + i * (bw + gap);
      ctx.fillRect(x, h - peaks[i] * maxBar - capH, bw, capH);
    }

    drawWaveLine(w, h * 0.3, h * 0.15, "rgba(148, 163, 184, 0.55)");
  }

  function drawRadial(w: number, h: number) {
    const n = disp.length;
    const cx = w / 2;
    const cy = h / 2;
    const base = Math.min(w, h);
    const R =
      base *
      params.get("radial", "radius") *
      (1 + rms * 0.9 + beat * params.get("radial", "pulse"));
    const maxLen = base * params.get("radial", "spokes");
    const lw = Math.max(2, ((Math.PI * R) / n) * 0.7);

    ctx.lineCap = "round";
    for (let i = 0; i < n; i++) {
      const v = disp[i];
      const len = Math.max(2, v * maxLen);
      const hue = 195 + (i / n) * 140;
      ctx.strokeStyle = `hsl(${hue}, 90%, ${50 + v * 25}%)`;
      ctx.lineWidth = lw;
      for (const sign of [-1, 1]) {
        const angle = -Math.PI / 2 + sign * ((i + 0.5) / n) * Math.PI;
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        ctx.beginPath();
        ctx.moveTo(cx + c * R, cy + s * R);
        ctx.lineTo(cx + c * (R + len), cy + s * (R + len));
        ctx.stroke();
      }
    }

    // waveform ring inside
    const r0 = R * 0.82;
    ctx.beginPath();
    for (let j = 0; j < wave.length; j++) {
      const angle = (j / (wave.length - 1)) * Math.PI * 2 - Math.PI / 2;
      const r = r0 + wave[j] * R * 0.3;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      if (j === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.strokeStyle = "rgba(186, 230, 253, 0.6)";
    ctx.lineWidth = Math.max(1, base * 0.002);
    ctx.stroke();
    ctx.lineCap = "butt";
  }

  function drawScope(w: number, h: number, dpr: number) {
    const amp = h * params.get("scope", "amp");
    const glow = params.get("scope", "glow");
    // wide soft glow pass, then bright core
    if (glow > 0) {
      drawWaveLine(w, h * 0.5, amp, "rgba(56, 189, 248, 0.18)", glow * dpr);
    }
    drawWaveLine(w, h * 0.5, amp, "#7dd3fc", 2 * dpr);

    // low bar strip at the bottom
    const n = disp.length;
    const gap = Math.max(1, w * 0.0025);
    const bw = (w - gap * (n + 1)) / n;
    const maxBar = h * 0.1;
    ctx.fillStyle = "rgba(129, 140, 248, 0.5)";
    for (let i = 0; i < n; i++) {
      const bh = disp[i] * maxBar;
      if (bh < 1) continue;
      ctx.fillRect(gap + i * (bw + gap), h - bh, bw, bh);
    }
  }

  function drawWaveLine(
    w: number,
    midY: number,
    amp: number,
    style: string,
    lineWidth?: number,
  ) {
    ctx.beginPath();
    for (let j = 0; j < wave.length; j++) {
      const x = (j / (wave.length - 1)) * w;
      const y = midY + wave[j] * amp;
      if (j === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = style;
    ctx.lineJoin = "round";
    ctx.lineWidth = lineWidth ?? Math.max(1, 1.25 * effectiveDpr());
    ctx.stroke();
  }

  raf = requestAnimationFrame(frame);

  return () => {
    running = false;
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", resize);
    viz3d?.dispose();
    try {
      bc?.loseGLContext();
    } catch {
      // Butterchurn may already have lost its context after a render failure.
    }
    if (bcAudioCtx) void bcAudioCtx.close();
  };
}

export default App;
