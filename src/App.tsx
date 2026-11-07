import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { BCVisualizer } from "butterchurn";
import { getBasePresetKeys } from "butterchurn-presets/presetPackMeta.js";
import { matchKey, withKey } from "./keys";
import { InfoOverlay } from "./ui/InfoOverlay";
import { SCENE_NAMES, type SceneName } from "./sceneCatalog";
import type { Viz3D } from "./scenes3d";
import { params, PARAMS_STORAGE_KEY } from "./params";
import { SettingsPanel } from "./SettingsPanel";
import { debugErrors, installErrorCapture, noteError } from "./debug";
import {
  addModel,
  clearAllModels,
  deleteModel,
  restoreModel,
  getModel,
  listModels,
  updateThumb,
  type ModelMeta,
} from "./modelStore";
import { LibraryModal } from "./LibraryModal";
import {
  addImage,
  clearAllImages,
  deleteImage,
  restoreImage,
  getImage,
  listImages,
  setImageDepth,
  updateImageThumb,
  type ImageMeta,
  type ImageRecord,
} from "./imageStore";
import type { ParallaxAsset } from "./parallax";
import type { MorphAsset } from "./morph";
import { gridFor } from "./morph";
import {
  MAX_FRAMES,
  addMorphSet,
  clearAllMorphSets,
  deleteMorphSet,
  restoreMorphSet,
  getMorphSet,
  listMorphSets,
  updateMorphThumb,
  type MorphMeta,
  type MorphRecord,
} from "./morphStore";
import { ComfyPanel, type BakeState } from "./ComfyPanel";
import {
  comfyBake,
  fillAxes,
  gridCells,
  loadAxes,
  loadComfyUrl,
  loadWorkflow,
  saveAxes,
  saveComfyUrl,
  saveWorkflow,
  type AxisRanges,
  type BakeKind,
} from "./comfy";
import { routing } from "./listeners";
import { RoutingModal } from "./RoutingModal";
import { MdTweakPanel } from "./MdTweakPanel";
import { HelpPanel } from "./HelpPanel";
import { PresetLibrary } from "./milkdrop/PresetLibrary";
import { TagBar } from "./milkdrop/TagBar";
import { Cockpit } from "./regie/Cockpit";
import { director } from "./regie/director";
import { RegieModal } from "./regie/RegieModal";
import { queue } from "./regie/queue";
import { contextRatings, type Scope } from "./regie/contextRatings";
import { nowPlaying, positionNow } from "./regie/nowPlaying";
import { choreos } from "./regie/choreo";
import { QueueBar } from "./regie/QueueBar";
import { TagChips } from "./milkdrop/TagChips";
import { buildCatalog } from "./milkdrop/catalog";
import { live, liveTimeByte, ENERGY_LEVELS } from "./milkdrop/live";
import { tagStore, useTags } from "./milkdrop/tags";
import { notePlayed, pickAuto, type TagMode } from "./milkdrop/autoswitch";
import { DEFAULT_LAYER_B, LayerB, shapeWave, type LayerBConfig } from "./milkdrop/layerB";
import { LayerPanel } from "./milkdrop/LayerPanel";
import { PresetStudio } from "./milkdrop/PresetStudio";
import { breedChild, isBreedKey, resolveBreed, spawn } from "./milkdrop/breed";
import { setBridgeHooks } from "./milkdrop/bridgeClient";
import { presetStore, useUserPresets } from "./milkdrop/presetStore";
import { compose, makePreset, type VizzyPreset } from "./milkdrop/vpreset";
import {
  CURATED,
  CURATED_PREFIX,
  DEFAULT_PRESET_KEY,
  findCurated,
} from "./curated";

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

type ImageAction =
  | { action: "load"; asset: ParallaxAsset; seq: number }
  | { action: "clear"; seq: number };

type MorphAction =
  | { action: "load"; asset: MorphAsset; seq: number }
  | { action: "clear"; seq: number };
import "./App.css";

// [rms, peak, n_bands, n_wave, beat, flux, bpm, bpm_conf,
//  beat_phase, beat_count, bar_phase, phrase_phase, section, grid_conf]
// Must match `HEADER` in src-tauri/src/audio.rs.
const HEADER = 14;

/** grid_conf above which bar/phrase positions are worth acting on. Measured
 *  in phrasing.rs: metrical input lands at 0.90–1.00, unmetrical at 0.13–0.27,
 *  so the threshold sits in the gap between them. */
const GRID_LOCKED = 0.5;
const PEAK_GRAVITY = 0.5; // units/s

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

type VizMode = "bars" | "radial" | "scope" | "spektro" | "milkdrop" | "3d";
const VIZ_MODES: VizMode[] = [
  "bars",
  "radial",
  "scope",
  "spektro",
  "milkdrop",
  "3d",
];
const VIZ_MODE_LABELS: Record<VizMode, string> = {
  bars: "Balken",
  radial: "Radial",
  scope: "Welle",
  spektro: "Spektro",
  milkdrop: "Milkdrop",
  "3d": "3D",
};

/** UI size tiers: dedicated dimensions per screen class, applied through
 *  CSS custom properties on the stage (see App.css `[data-ui=...]`). */
type UiScalePref = "auto" | "compact" | "normal" | "tv";
const UI_SCALES: UiScalePref[] = ["auto", "compact", "normal", "tv"];
const UI_SCALE_LABELS: Record<UiScalePref, string> = {
  auto: "Auto",
  compact: "Kompakt",
  normal: "Normal",
  tv: "TV",
};

function resolveUiTier(pref: UiScalePref, width: number): string {
  if (pref !== "auto") return pref;
  if (width <= 760) return "compact";
  // 10-foot UI: very wide, or big screen without hover (TV browsers/remotes)
  const noHover = window.matchMedia?.("(hover: none)").matches ?? false;
  if (width >= 2200 || (width >= 1600 && noHover)) return "tv";
  return "normal";
}

type BgLayer = "off" | "milkdrop" | "3d";
const BG_LAYERS: BgLayer[] = ["off", "milkdrop", "3d"];
const BLEND_MODES = ["screen", "lighten", "overlay", "normal"] as const;
type BlendMode = (typeof BLEND_MODES)[number];

function is2DMode(m: VizMode): boolean {
  return (
    m === "bars" || m === "radial" || m === "scope" || m === "spektro"
  );
}

/** The waterfall owns every pixel of its canvas, so it can't sit on top of a
 *  background layer the way the translucent 2D modes do. */
function supportsBgLayer(m: VizMode): boolean {
  return is2DMode(m) && m !== "spektro";
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

/** Human-readable name for a preset key of any flavour. */
function presetLabel(key: string): string {
  if (key.startsWith("breed:")) {
    return `🧬 ${breedChild(key)?.preset.name ?? key}`;
  }
  if (key.startsWith(CURATED_PREFIX)) {
    return `✦ ${key.slice(CURATED_PREFIX.length)}`;
  }
  return key.startsWith("user:") ? key.slice(5) : key;
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
  imageId?: number;
  morphId?: number;
  bgLayer?: BgLayer;
  blendMode?: BlendMode;
  debug?: boolean;
  uiScale?: UiScalePref;
  favorites?: string[];
  favOnly?: boolean;
  /** presets that kept trapping — skipped by ←/→, Zufall and auto */
  quarantine?: string[];
  tagFilter?: string[];
  tagFilterMode?: "any" | "all";
  layerB?: Partial<LayerBConfig>;
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
  const userPresets = useUserPresets();
  const [presetKey, setPresetKey] = useState(() => {
    const k = saved.presetKey;
    if (!k) return DEFAULT_PRESET_KEY; // first run opens on a curated one
    if (PRESET_KEYS.includes(k)) return k;
    if (findCurated(k)) return k;
    // own presets load from files asynchronously; checked once they are in
    if (k.startsWith("user:")) return k;
    return DEFAULT_PRESET_KEY;
  });
  const [autoSwitch, setAutoSwitch] = useState(saved.autoSwitch ?? false);
  const [favorites, setFavorites] = useState<string[]>(
    () => saved.favorites ?? [],
  );
  const [favOnly, setFavOnly] = useState(saved.favOnly ?? false);
  const [quarantine, setQuarantine] = useState<string[]>(
    () => saved.quarantine ?? [],
  );
  const [tagFilter, setTagFilter] = useState<string[]>(() => saved.tagFilter ?? []);
  const [tagFilterMode, setTagFilterMode] = useState<"any" | "all">(
    () => saved.tagFilterMode ?? "any",
  );
  const [presetLibOpen, setPresetLibOpen] = useState(false);
  /** preset key the studio was opened on; null = closed */
  const [studioKey, setStudioKey] = useState<string | null>(null);
  /** the library was opened to pick layer B's preset, not the main one */
  const [libTarget, setLibTarget] = useState<"a" | "b">("a");
  const [layerB, setLayerB] = useState<LayerBConfig>(() => ({
    ...DEFAULT_LAYER_B,
    ...(saved.layerB ?? {}),
  }));
  const layerBRef = useRef(layerB);
  useEffect(() => {
    layerBRef.current = layerB;
  }, [layerB]);
  const mdCanvasBRef = useRef<HTMLCanvasElement | null>(null);
  const [layerBError, setLayerBError] = useState("");
  const [tagBarOpen, setTagBarOpen] = useState(false);
  const [regieOpen, setRegieOpen] = useState(false);
  const [cockpitOpen, setCockpitOpen] = useState(() => {
    try {
      return localStorage.getItem("vizzy.cockpit.open") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("vizzy.cockpit.open", cockpitOpen ? "1" : "0");
    } catch {
      // ignore
    }
  }, [cockpitOpen]);
  const [tagFilterOpen, setTagFilterOpen] = useState(false);
  const tagsVersion = useTags();
  /** overrides to apply right after the next preset switch (library variant) */
  const pendingOverridesRef = useRef<Record<string, number> | null>(null);
  const [showBpm, setShowBpm] = useState(saved.showBpm ?? false);
  const [debugOpen, setDebugOpen] = useState(saved.debug ?? false);
  const debugElRef = useRef<HTMLPreElement | null>(null);
  const freqCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [uiScale, setUiScale] = useState<UiScalePref>(
    saved.uiScale && UI_SCALES.includes(saved.uiScale) ? saved.uiScale : "auto",
  );
  const [viewportW, setViewportW] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setViewportW(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const uiTier = resolveUiTier(uiScale, viewportW);
  // One drawer holds settings, tweaks, routing, ComfyUI and help; the old
  // per-panel flags are now "drawer open on that tab".
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<string>("audio");
  const tabFlag = (
    id: string,
  ): [boolean, (v: boolean | ((prev: boolean) => boolean)) => void] => {
    const open = settingsOpen && drawerTab === id;
    return [
      open,
      (v) => {
        const next = typeof v === "function" ? v(open) : v;
        if (next) {
          setDrawerTab(id);
          setSettingsOpen(true);
        } else if (open) {
          setSettingsOpen(false);
        }
      },
    ];
  };
  const [helpOpen, setHelpOpen] = tabFlag("help");
  const toggleDrawer = () => {
    if (settingsOpen) {
      setSettingsOpen(false);
      return;
    }
    if (drawerTab === "help") setDrawerTab("audio");
    setSettingsOpen(true);
  };
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null);
  const helpButtonRef = useRef<HTMLButtonElement | null>(null);

  // Parameters live outside React (the render loop reads them per frame), so
  // anything rendered from them needs an explicit nudge on change.
  const [, bumpParams] = useReducer((n: number) => n + 1, 0);
  useEffect(() => params.subscribe(bumpParams), []);
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
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const depthInputRef = useRef<HTMLInputElement | null>(null);
  const imageFileRef = useRef<ImageAction | null>(null);
  const [images, setImages] = useState<ImageMeta[]>([]);
  const [selectedImageId, setSelectedImageId] = useState<number | null>(null);
  const morphInputRef = useRef<HTMLInputElement | null>(null);
  const morphFileRef = useRef<MorphAction | null>(null);
  const [morphSets, setMorphSets] = useState<MorphMeta[]>([]);
  const [selectedMorphId, setSelectedMorphId] = useState<number | null>(null);
  const [comfyOpen, setComfyOpen] = tabFlag("comfy");
  const [bakeKind, setBakeKind] = useState<BakeKind>("depth");
  const [comfyUrl, setComfyUrl] = useState(loadComfyUrl);
  const [workflows, setWorkflows] = useState<Record<BakeKind, string>>(() => ({
    depth: loadWorkflow("depth"),
    variants: loadWorkflow("variants"),
  }));
  const [axes, setAxes] = useState<AxisRanges>(loadAxes);
  const [bakeState, setBakeState] = useState<BakeState>({ kind: "idle" });
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [routingOpen, setRoutingOpen] = tabFlag("routing");
  const [tweakOpen, setTweakOpen] = tabFlag("tweaks");
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
  // Presentation mode: the controls stay away on mouse movement; keys keep
  // working. Survives a restart, so a party machine comes up clean.
  const [presentation, setPresentation] = useState(() => {
    try {
      return localStorage.getItem("vizzy.presentation") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    // a toolbar button keeping focus would hold the hidden toolbar "in use"
    if (presentation) {
      const a = document.activeElement;
      if (a instanceof HTMLElement && a.closest(".hud")) a.blur();
    }
    try {
      localStorage.setItem("vizzy.presentation", presentation ? "1" : "0");
    } catch {
      // ignore
    }
  }, [presentation]);
  /** bumped by I — the info overlay shows itself for a few seconds */
  const [infoNonce, setInfoNonce] = useState(0);
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
    setMdOverrides(pendingOverridesRef.current ?? {});
    pendingOverridesRef.current = null;
    notePlayed(presetKey);
  }, [presetKey]);

  useEffect(() => {
    // the tweaks tab only exists in Milkdrop mode
    if (mode !== "milkdrop" && drawerTab === "tweaks") setDrawerTab("milkdrop");
  }, [mode, drawerTab]);

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
      mode === "milkdrop" || bgLayer === "milkdrop" || tweakOpen || presetLibOpen;
    if (needed && milkdropStatus === "idle") {
      void requestMilkdropRuntime();
    }
  }, [
    mode,
    bgLayer,
    tweakOpen,
    presetLibOpen,
    milkdropStatus,
    requestMilkdropRuntime,
  ]);

  const resolvePreset = useCallback(
    (key: string): unknown | null => {
      // Own presets are made of parts that may come from any other preset,
      // own ones included — hence the recursion (compose caps the depth).
      const resolveAt = (k: string, depth: number): unknown | null => {
        const curated = findCurated(k);
        if (curated) {
          const base = PRESETS[curated.base];
          return base ? mergeBaseVals(base, curated.overrides) : null;
        }
        if (k.startsWith("user:")) {
          const up = userPresets.find((p) => p.name === k.slice(5));
          return up ? compose(up, resolveAt, depth) : null;
        }
        if (isBreedKey(k)) return resolveBreed(k, resolveAt, depth);
        return PRESETS[k] ?? null;
      };
      return resolveAt(key, 0);
    },
    [userPresets, milkdropStatus],
  );

  // An own preset whose file changed (saved here, or written by an editor
  // or Claude Code) reloads in place.
  const currentUserPreset = presetKey.startsWith("user:")
    ? userPresets.find((p) => p.name === presetKey.slice(5))
    : undefined;
  useEffect(() => {
    if (!currentUserPreset) return;
    overridesRef.current = {
      version: overridesRef.current.version + 1,
      map: overridesRef.current.map,
    };
  }, [currentUserPreset]);

  // a remembered own preset that no longer exists → back to the default
  useEffect(() => {
    if (presetStore.loaded && presetKey.startsWith("user:") && !currentUserPreset) {
      setPresetKey(DEFAULT_PRESET_KEY);
    }
  }, [userPresets, presetKey, currentUserPreset]);
  const resolvePresetRef = useRef(resolvePreset);
  useEffect(() => {
    resolvePresetRef.current = resolvePreset;
  }, [resolvePreset]);

  const allPresetKeys = useMemo(
    () => [
      ...CURATED.map((p) => `${CURATED_PREFIX}${p.name}`),
      ...userPresets.map((p) => `user:${p.name}`),
      ...PRESET_KEYS,
    ],
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
      // Saving forks whatever is on screen into a user preset. Curated and
      // user presets are themselves base+overrides, so resolve down to the
      // real Butterchurn key and carry their overrides along — storing
      // "vizzy:Kirchenfenster" as a base would not resolve later.
      const curated = findCurated(presetKey);
      const currentUser = presetKey.startsWith("user:")
        ? userPresets.find((p) => p.name === presetKey.slice(5))
        : undefined;
      const parent = curated ?? currentUser;
      const overrides = { ...(parent?.overrides ?? {}), ...mdOverrides };
      const vp: VizzyPreset =
        currentUser && currentUser.name === name
          ? { ...currentUser, overrides }
          : makePreset(name, parent?.base ?? presetKey, {
              // an own preset's parts (mashup, code edits) carry over
              parts: currentUser ? JSON.parse(JSON.stringify(currentUser.parts)) : {},
              overrides,
              lineage: { parents: [presetKey], op: "tweak", at: Date.now() },
            });
      void presetStore.save(vp);
      setPresetKey(`user:${name}`);
      setMdOverrides({});
      flog(`[md] user preset saved: ${name}`);
    },
    [presetKey, userPresets, mdOverrides],
  );

  /* ---- undo for deletions: delete right away, offer to take it back ---- */
  const [undo, setUndo] = useState<{ msg: string; run: () => void } | null>(null);
  const undoTimer = useRef(0);
  const undoRef = useRef<(() => void) | null>(null);
  const offerUndo = useCallback((msg: string, run: () => void) => {
    window.clearTimeout(undoTimer.current);
    undoRef.current = run;
    setUndo({ msg, run });
    undoTimer.current = window.setTimeout(() => {
      undoRef.current = null;
      setUndo(null);
    }, 8000);
  }, []);
  const runUndo = useCallback(() => {
    window.clearTimeout(undoTimer.current);
    const run = undoRef.current;
    undoRef.current = null;
    setUndo(null);
    run?.();
  }, []);

  const removeUserPreset = useCallback(
    (name: string) => {
      const up = userPresets.find((p) => p.name === name);
      const key = `user:${name}`;
      const wasFav = favorites.includes(key);
      const tags = tagStore.get(key);
      const wasPlaying = presetKey === key;
      void presetStore.remove(name);
      setFavorites((prev) => prev.filter((k) => k !== key));
      tagStore.move(key, null);
      if (wasPlaying) {
        setPresetKey(up && PRESETS[up.base] ? up.base : (PRESET_KEYS[0] ?? ""));
      }
      if (up) {
        offerUndo(`„${name}“ gelöscht`, () => {
          void presetStore.save(up).then(() => {
            tagStore.set(key, tags);
            if (wasFav) setFavorites((prev) => (prev.includes(key) ? prev : [...prev, key]));
            if (wasPlaying) setPresetKey(key);
          });
        });
      }
    },
    [userPresets, presetKey, favorites, offerUndo],
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
      imageId: selectedImageId ?? undefined,
      morphId: selectedMorphId ?? undefined,
      bgLayer,
      blendMode,
      debug: debugOpen,
      uiScale,
      favorites,
      favOnly,
      quarantine,
      tagFilter,
      tagFilterMode,
      layerB,
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
    selectedImageId,
    selectedMorphId,
    bgLayer,
    blendMode,
    debugOpen,
    uiScale,
    favorites,
    favOnly,
    quarantine,
    tagFilter,
    tagFilterMode,
    layerB,
  ]);

  const isFavorite = favorites.includes(presetKey);

  const toggleFavorite = useCallback((key: string) => {
    if (!key) return;
    setFavorites((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  }, []);

  // Favourites-only browsing falls back to the full list while there is
  // nothing (or only one thing) starred — otherwise ←/→ would be a dead key.
  const browseKeys = useMemo(() => {
    // A quarantined preset is one that trapped repeatedly; it stays in the
    // picker (choosing it there releases it) but out of the rotation.
    // Tag filter narrows first; favourites-only narrows further. Either one
    // leaving fewer than two presets is ignored rather than killing the keys.
    let pool = allPresetKeys.filter((k) => !quarantine.includes(k));
    if (tagFilter.length) {
      const tagged = pool.filter((k) =>
        tagStore.matches(k, tagFilter, tagFilterMode, favorites),
      );
      if (tagged.length > 1) pool = tagged;
    }
    if (!favOnly) return pool;
    const list = favorites.filter((k) => pool.includes(k));
    return list.length > 1 ? list : pool;
    // tagsVersion: re-filter when tags change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [favOnly, favorites, allPresetKeys, quarantine, tagFilter, tagFilterMode, tagsVersion]);

  const catalog = useMemo(
    () => buildCatalog(PRESET_KEYS, CURATED, CURATED_PREFIX, userPresets),
    [userPresets],
  );

  // The auto-switch picks through a ref so the render loop never has to be
  // restarted when the browse list or the tags change.
  const autoPickRef = useRef((_reason: "auto" | "trap" | "skip") => {});
  useEffect(() => {
    autoPickRef.current = (reason) => {
      // a matching rule (Regie) may hold the picture or pick from its pool
      if (director.override(reason)) return;
      const tagMode = (params.get("milkdrop", "tagMode") | 0) as TagMode;
      const nextA = pickAuto(browseKeys, presetKeyRef.current, tagMode);
      const breedP = params.get("milkdrop", "breed");
      if (breedP > 0 && Math.random() < breedP) {
        // a mutated child of the chosen preset instead — probing takes a
        // moment, the parent stands in if nothing usable comes out
        void spawn(nextA, presetLabel(nextA).replace(/^✦ /, ""), (k) => resolvePresetRef.current(k), {
          strength: params.get("milkdrop", "breedStrength"),
          code: params.get("milkdrop", "breedCode") >= 0.5,
        }).then((child) => {
          setPresetKey(child ?? nextA);
          if (child) live.lastPick += ` → Zucht ${child.slice(6)}`;
        });
      } else {
        setPresetKey(nextA);
      }
      const b = layerBRef.current;
      if (b.enabled && b.auto) {
        // one bar later, so the whole picture never changes at once
        window.setTimeout(() => {
          const pool = browseKeys.filter((k) => k !== nextA);
          const nextB = pickAuto(pool, layerBRef.current.key, tagMode);
          setLayerB((cfg) => ({ ...cfg, key: nextB }));
        }, live.barSeconds() * 1000);
      }
    };
  }, [browseKeys]);
  const autoPick = useCallback(
    (reason: "auto" | "trap" | "skip" = "auto") => autoPickRef.current(reason),
    [],
  );

  // Choreo recording: every picture change while the song plays is a cue.
  useEffect(() => {
    if (!choreos.getRec()) return;
    const t = nowPlaying.getSnapshot().track;
    if (t) choreos.record(t, positionNow(t) ?? 0, presetKey);
  }, [presetKey]);

  // Regie: rules apply presets/combos on song changes. A picture the
  // director just put up gets a full cooldown before the auto-switch may
  // replace it.
  const directorSwitchAtRef = useRef(0);
  const playableRef = useRef<Set<string>>(new Set());
  playableRef.current = useMemo(
    () => new Set(allPresetKeys.filter((k) => !quarantine.includes(k))),
    [allPresetKeys, quarantine],
  );
  useEffect(
    () =>
      director.attach({
        applyPreset: (key) => {
          directorSwitchAtRef.current = performance.now();
          setPresetKey(key);
        },
        applyCombo: (c) => {
          directorSwitchAtRef.current = performance.now();
          setPresetKey(c.a);
          setLayerB(c.b);
        },
        playable: () => playableRef.current,
        currentKey: () => presetKeyRef.current,
        label: presetLabel,
      }),
    [],
  );

  const applyFromLibrary = useCallback(
    (key: string, overrides?: Record<string, number>) => {
      setQuarantine((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : prev));
      if (key === presetKeyRef.current) {
        setMdOverrides(overrides ?? {});
      } else {
        pendingOverridesRef.current = overrides ?? null;
        setPresetKey(key);
      }
    },
    [],
  );

  const quarantinePreset = useCallback((key: string) => {
    setQuarantine((prev) => (prev.includes(key) ? prev : [...prev, key]));
  }, []);

  /** Picking a preset by hand gives it another chance. */
  const pickPreset = useCallback((key: string) => {
    setQuarantine((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : prev,
    );
    setPresetKey(key);
  }, []);

  const stepPreset = useCallback(
    (dir: number) => {
      setPresetKey((current) => {
        const i = browseKeys.indexOf(current);
        // not in the current list (e.g. unstarred while browsing favourites):
        // dir > 0 lands on the first entry, dir < 0 on the last
        if (i === -1) return browseKeys[dir > 0 ? 0 : browseKeys.length - 1];
        return browseKeys[(i + dir + browseKeys.length) % browseKeys.length];
      });
    },
    [browseKeys],
  );

  const randomPreset = useCallback(() => {
    setPresetKey((current) => {
      if (browseKeys.length < 2) return browseKeys[0] ?? current;
      // never redraw the preset that is already on screen
      let next = current;
      while (next === current) {
        next = browseKeys[Math.floor(Math.random() * browseKeys.length)];
      }
      return next;
    });
  }, [browseKeys]);

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
      // keep the record so the deletion can be taken back
      const record = await getModel(id).catch(() => undefined);
      const wasSelected = selectedModelId === id;
      try {
        await deleteModel(id);
      } catch (err) {
        flog(`[cfg] model delete FAILED: ${err}`);
      }
      if (wasSelected) {
        setSelectedModelId(null);
        modelFileRef.current = { action: "clear", seq: nextModelSeq() };
      }
      refreshModels();
      if (record) {
        offerUndo(`Modell „${record.name}“ gelöscht`, () => {
          void restoreModel(record)
            .then(() => {
              refreshModels();
              if (wasSelected) void pickModel(id);
            })
            .catch((err) => flog(`[cfg] model restore FAILED: ${err}`));
        });
      }
    },
    [selectedModelId, nextModelSeq, refreshModels, pickModel, offerUndo],
  );

  /* ---- parallax: image + depth-map pairs for the 2.5D scene ---- */

  const nextImageSeq = useCallback(
    () => (imageFileRef.current?.seq ?? 0) + 1,
    [],
  );

  const refreshImages = useCallback(() => {
    listImages().then(setImages).catch(console.error);
  }, []);

  const queueImage = useCallback(
    (record: ImageRecord) => {
      imageFileRef.current = {
        action: "load",
        asset: {
          name: record.name,
          image: record.image,
          imageType: record.imageType,
          depth: record.depth,
          depthType: record.depthType,
        },
        seq: nextImageSeq(),
      };
    },
    [nextImageSeq],
  );

  const onImageFile = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = ""; // allow re-picking the same file
      if (!file) return;
      const data = await file.arrayBuffer();
      const imageType = file.type || "image/png";
      // show it immediately; the pseudo depth map carries it until a bake exists
      queueImage({
        name: file.name,
        image: data,
        imageType,
        size: data.byteLength,
        addedAt: Date.now(),
      });
      setScene3d("parallax");
      try {
        const id = await addImage(file.name, data, imageType);
        setSelectedImageId(id);
        refreshImages();
        flog(`[cfg] image saved: ${file.name} (#${id})`);
        try {
          const { imageThumb } = await import("./parallax");
          const bitmap = await createImageBitmap(
            new Blob([data], { type: imageType }),
            { imageOrientation: "flipY" },
          );
          await updateImageThumb(id, imageThumb(bitmap));
          refreshImages();
        } catch {
          // preview is optional
        }
      } catch (err) {
        flog(`[cfg] image save FAILED: ${err}`);
      }
    },
    [queueImage, refreshImages],
  );

  /** Attach a baked depth map (ComfyUI → Depth Anything) to the current image. */
  const onDepthFile = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file || selectedImageId == null) return;
      const data = await file.arrayBuffer();
      try {
        const record = await setImageDepth(
          selectedImageId,
          data,
          file.type || "image/png",
        );
        if (!record) return;
        queueImage(record);
        refreshImages();
        flog(`[cfg] depth map attached: ${file.name}`);
      } catch (err) {
        flog(`[cfg] depth attach FAILED: ${err}`);
      }
    },
    [selectedImageId, queueImage, refreshImages],
  );

  const pickImage = useCallback(
    async (id: number | null) => {
      if (id == null) {
        setSelectedImageId(null);
        imageFileRef.current = { action: "clear", seq: nextImageSeq() };
        return;
      }
      try {
        const record = await getImage(id);
        if (!record) return;
        setSelectedImageId(id);
        queueImage(record);
      } catch (err) {
        flog(`[cfg] image pick FAILED: ${err}`);
      }
    },
    [nextImageSeq, queueImage],
  );

  const removeImage = useCallback(
    async (id: number) => {
      // keep the record so the deletion can be taken back
      const record = await getImage(id).catch(() => undefined);
      const wasSelected = selectedImageId === id;
      try {
        await deleteImage(id);
      } catch (err) {
        flog(`[cfg] image delete FAILED: ${err}`);
      }
      if (wasSelected) {
        setSelectedImageId(null);
        imageFileRef.current = { action: "clear", seq: nextImageSeq() };
      }
      refreshImages();
      if (record) {
        offerUndo(`Bild „${record.name}“ gelöscht`, () => {
          void restoreImage(record)
            .then(() => {
              refreshImages();
              if (wasSelected) void pickImage(id);
            })
            .catch((err) => flog(`[cfg] image restore FAILED: ${err}`));
        });
      }
    },
    [selectedImageId, nextImageSeq, refreshImages, pickImage, offerUndo],
  );

  /* ---- morph: sets of variants for the 2D control surface ---- */

  const nextMorphSeq = useCallback(
    () => (morphFileRef.current?.seq ?? 0) + 1,
    [],
  );

  const refreshMorphSets = useCallback(() => {
    listMorphSets().then(setMorphSets).catch(console.error);
  }, []);

  const queueMorph = useCallback(
    (record: MorphRecord) => {
      morphFileRef.current = {
        action: "load",
        asset: {
          name: record.name,
          frames: record.frames,
          frameType: record.frameType,
        },
        seq: nextMorphSeq(),
      };
    },
    [nextMorphSeq],
  );

  /**
   * Frames arrive as a multi-selection and are ordered by filename: a ComfyUI
   * batch writes `..._00001_.png`, `..._00002_.png`, … so the output order is
   * the control-surface order without anyone having to arrange anything.
   */
  const onMorphFiles = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const picked = Array.from(e.target.files ?? []);
      e.target.value = "";
      if (picked.length === 0) return;
      const files = picked
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
        .slice(0, MAX_FRAMES);
      if (picked.length > MAX_FRAMES) {
        flog(
          `[cfg] morph set truncated to ${MAX_FRAMES} of ${picked.length} frames`,
        );
      }
      const frames = await Promise.all(files.map((f) => f.arrayBuffer()));
      const frameType = files[0].type || "image/png";
      const name = `${files[0].name} +${files.length - 1}`;
      queueMorph({
        name,
        frames,
        frameType,
        size: frames.reduce((n, f) => n + f.byteLength, 0),
        addedAt: Date.now(),
      });
      setScene3d("morph");
      try {
        const id = await addMorphSet(name, frames, frameType);
        setSelectedMorphId(id);
        refreshMorphSets();
        flog(`[cfg] morph set saved: ${name} (#${id}, ${frames.length} frames)`);
        try {
          const { morphThumb } = await import("./morph");
          const bitmap = await createImageBitmap(
            new Blob([frames[0]], { type: frameType }),
          );
          await updateMorphThumb(id, morphThumb(bitmap));
          bitmap.close();
          refreshMorphSets();
        } catch {
          // preview is optional
        }
      } catch (err) {
        flog(`[cfg] morph save FAILED: ${err}`);
      }
    },
    [queueMorph, refreshMorphSets],
  );

  const pickMorphSet = useCallback(
    async (id: number | null) => {
      if (id == null) {
        setSelectedMorphId(null);
        morphFileRef.current = { action: "clear", seq: nextMorphSeq() };
        return;
      }
      try {
        const record = await getMorphSet(id);
        if (!record) return;
        setSelectedMorphId(id);
        queueMorph(record);
      } catch (err) {
        flog(`[cfg] morph pick FAILED: ${err}`);
      }
    },
    [nextMorphSeq, queueMorph],
  );

  const removeMorphSet = useCallback(
    async (id: number) => {
      // keep the record so the deletion can be taken back
      const record = await getMorphSet(id).catch(() => undefined);
      const wasSelected = selectedMorphId === id;
      try {
        await deleteMorphSet(id);
      } catch (err) {
        flog(`[cfg] morph delete FAILED: ${err}`);
      }
      if (wasSelected) {
        setSelectedMorphId(null);
        morphFileRef.current = { action: "clear", seq: nextMorphSeq() };
      }
      refreshMorphSets();
      if (record) {
        offerUndo(`Varianten-Satz „${record.name}“ gelöscht`, () => {
          void restoreMorphSet(record)
            .then(() => {
              refreshMorphSets();
              if (wasSelected) void pickMorphSet(id);
            })
            .catch((err) => flog(`[cfg] morph restore FAILED: ${err}`));
        });
      }
    },
    [selectedMorphId, nextMorphSeq, refreshMorphSets, pickMorphSet, offerUndo],
  );

  /**
   * Push the selected image through ComfyUI: either once, for a depth map,
   * or once per grid cell, for a morph set. Either way it runs offline, long
   * before playback — the scenes themselves never touch ComfyUI.
   */
  const runBake = useCallback(async () => {
    if (selectedImageId == null) return;
    if (!inTauri) {
      setBakeState({
        kind: "error",
        msg: "Backen geht nur in der Desktop-App: der Browser darf ComfyUI nicht direkt ansprechen (keine CORS-Header).",
      });
      return;
    }
    setBakeState({ kind: "running" });
    const started = performance.now();
    try {
      const record = await getImage(selectedImageId);
      if (!record) throw new Error("Bild ist nicht mehr in der Library");

      if (bakeKind === "depth") {
        const out = await comfyBake(
          comfyUrl,
          workflows.depth,
          record.image,
          record.name,
        );
        if (out.length === 0 || out[0].byteLength === 0) {
          throw new Error("ComfyUI lieferte kein Bild zurück");
        }
        const updated = await setImageDepth(
          selectedImageId,
          out[0],
          "image/png",
        );
        if (!updated) throw new Error("Tiefenkarte ließ sich nicht speichern");
        queueImage(updated); // the scene picks it up on the next frame
        refreshImages();
        const secs = ((performance.now() - started) / 1000).toFixed(1);
        setBakeState({
          kind: "ok",
          msg: `${Math.round(out[0].byteLength / 1024)} KB in ${secs}s — die Parallax-Szene läuft schon darauf.`,
        });
        flog(`[comfy] depth baked for ${record.name} in ${secs}s`);
        return;
      }

      // Variants: one run per cell, because a batched run shares its
      // conditioning and would differ only by noise — coherent but unordered,
      // and the grid's axes only mean something if the order does.
      const cells = gridCells(axes);
      const frames: ArrayBuffer[] = [];
      for (const cell of cells) {
        setBakeState({
          kind: "running",
          msg: `Zelle ${cell.index + 1} von ${cells.length} (x ${cell.x.toFixed(2)}, y ${cell.y.toFixed(2)})`,
        });
        const out = await comfyBake(
          comfyUrl,
          fillAxes(workflows.variants, cell),
          record.image,
          record.name,
        );
        if (out.length === 0 || out[0].byteLength === 0) {
          throw new Error(
            `Zelle ${cell.index + 1} lieferte kein Bild — ${frames.length} von ${cells.length} fertig`,
          );
        }
        // one cell is one picture; a workflow saving more keeps its first
        frames.push(out[0]);
      }

      const secs = ((performance.now() - started) / 1000).toFixed(1);
      const kb = Math.round(
        frames.reduce((n, b) => n + b.byteLength, 0) / 1024,
      );
      const name = `${record.name} ×${frames.length}`;
      const id = await addMorphSet(name, frames, "image/png");
      setSelectedMorphId(id);
      queueMorph({
        name,
        frames,
        frameType: "image/png",
        size: kb * 1024,
        addedAt: Date.now(),
      });
      refreshMorphSets();
      setScene3d("morph");
      const { cols, rows } = gridFor(frames.length);
      setBakeState({
        kind: "ok",
        msg: `${frames.length} Varianten in ${secs}s → ${cols}×${rows}-Raster, ${kb} KB. Die Morph-Szene läuft schon darauf.`,
      });
      flog(
        `[comfy] ${frames.length} variants baked from ${record.name} in ${secs}s`,
      );
      try {
        const { morphThumb } = await import("./morph");
        const bitmap = await createImageBitmap(
          new Blob([frames[0]], { type: "image/png" }),
        );
        await updateMorphThumb(id, morphThumb(bitmap));
        bitmap.close();
        refreshMorphSets();
      } catch {
        // preview is optional
      }
    } catch (err) {
      setBakeState({ kind: "error", msg: String(err) });
      flog(`[comfy] bake FAILED: ${err}`);
    }
  }, [
    selectedImageId,
    comfyUrl,
    workflows,
    bakeKind,
    axes,
    queueImage,
    refreshImages,
    queueMorph,
    refreshMorphSets,
  ]);

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

  // Same for the parallax image library.
  const imageRestoredRef = useRef(false);
  useEffect(() => {
    if (imageRestoredRef.current) return;
    imageRestoredRef.current = true;
    void (async () => {
      try {
        const list = await listImages();
        setImages(list);
        const id = saved.imageId;
        if (id != null && list.some((i) => i.id === id)) {
          const record = await getImage(id);
          if (record) {
            setSelectedImageId(id);
            queueImage(record);
            flog(`[cfg] restored image: ${record.name}`);
          }
        }
      } catch {
        // library unavailable — placeholder stays
      }
    })();
  }, [queueImage]);

  // Same for the morph-set library.
  const morphRestoredRef = useRef(false);
  useEffect(() => {
    if (morphRestoredRef.current) return;
    morphRestoredRef.current = true;
    void (async () => {
      try {
        const list = await listMorphSets();
        setMorphSets(list);
        const id = saved.morphId;
        if (id != null && list.some((m) => m.id === id)) {
          const record = await getMorphSet(id);
          if (record) {
            setSelectedMorphId(id);
            queueMorph(record);
            flog(`[cfg] restored morph set: ${record.name}`);
          }
        }
      } catch {
        // library unavailable — placeholder stays
      }
    })();
  }, [queueMorph]);

  // Emergency exit: wipe settings, parameters and the model library.
  const resetAll = useCallback(() => {
    try {
      localStorage.removeItem(SETTINGS_KEY);
      localStorage.removeItem(PARAMS_STORAGE_KEY);
    } catch {
      // ignore — reload restores defaults either way
    }
    void Promise.all([
      clearAllModels().catch(() => {}),
      clearAllImages().catch(() => {}),
      clearAllMorphSets().catch(() => {}),
    ]).finally(() => window.location.reload());
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
      autoPick,
      quarantinePreset,
      bpmElRef,
      modelFileRef,
      imageFileRef,
      morphFileRef,
      camResetRef,
      bgLayerRef,
      blendRef,
      overridesRef,
      resolvePresetRef,
      debugElRef,
      freqCanvasRef,
      mdCanvasBRef,
      layerBRef,
      setLayerBError,
      directorSwitchAtRef,
    );
  }, [autoPick, quarantinePreset]);

  // what the dev bridge may see and do (src/milkdrop/bridgeClient.ts)
  useEffect(() => {
    setBridgeHooks({
      state: () => ({
        mode: modeRef.current,
        preset: presetKeyRef.current,
        label: presetLabel(presetKeyRef.current),
        tags: tagStore.get(presetKeyRef.current),
        rating: tagStore.rating(presetKeyRef.current),
        layerB: layerBRef.current,
        energy: ENERGY_LEVELS[live.level],
        bpm: Math.round(live.bpm),
        lastPick: live.lastPick,
        ownPresets: presetStore.getSnapshot().map((p) => `user:${p.name}`),
      }),
      play: (k) => {
        setPresetKey(k);
        setMode("milkdrop");
      },
      resolve: (k) => resolvePresetRef.current(k),
      canvas: () => mdCanvasRef.current,
    });
  }, []);

  const [toast, setToast] = useState("");
  const toastTimer = useRef(0);
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2200);
  }, []);

  /** + / - while listening. On a bred child, + keeps it as an own preset
   *  and both count for the parent; - also moves on right away. */
  const ratePreset = useCallback(
    (dir: 1 | -1) => {
      const key = presetKeyRef.current;
      const child = isBreedKey(key) ? breedChild(key) : undefined;
      const target = child?.parent ?? key;
      const r = tagStore.rate(target, dir);
      // also learn: this picture fits (or not) this song / artist / playlist
      const track = nowPlaying.getSnapshot().track;
      const rateCtx = (k: string): string => {
        if (!track || track.status === "other") return "";
        const scopes = contextRatings.rate(track, k, dir);
        const name: Record<Scope, string> = { song: "Song", artist: "Artist", playlist: "Playlist" };
        return scopes.length ? ` · gemerkt für ${scopes.map((s) => name[s]).join(", ")}` : "";
      };
      if (child && dir > 0) {
        const vp = { ...child.preset, tags: tagStore.get(child.parent) };
        void presetStore.save(vp).then(() => tagStore.set(`user:${vp.name}`, vp.tags ?? []));
        showToast(`♥ behalten als „${vp.name}“${rateCtx(`user:${vp.name}`)}`);
      } else {
        showToast(
          `${dir > 0 ? "♥" : "✕"} ${presetLabel(target)} · Bewertung ${r > 0 ? "+" : ""}${r}${rateCtx(target)}`,
        );
      }
      if (dir < 0) autoPickRef.current("skip");
    },
    [showToast],
  );

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
    settingsOpen ||
    helpOpen ||
    libraryOpen ||
    presetLibOpen ||
    studioKey !== null ||
    tagBarOpen ||
    routingOpen ||
    (tweakOpen && mode === "milkdrop");

  // read in render scope so a change in the settings panel re-arms the timer
  const hideDelay = params.get("ui", "hideDelay");
  const pokeHud = useCallback(() => {
    window.clearTimeout(hideTimer.current);
    if (presentation) {
      setHudVisible(false);
      return;
    }
    setHudVisible(true);
    if (hudPinned || hideDelay <= 0) return; // 0 = stay visible
    hideTimer.current = window.setTimeout(() => {
      if (!document.querySelector(".hud:focus-within")) {
        setHudVisible(false);
      }
    }, hideDelay * 1000);
  }, [hudPinned, hideDelay, presentation]);

  useEffect(() => {
    pokeHud();
    return () => window.clearTimeout(hideTimer.current);
  }, [pokeHud]);

  // Key-triggered preset changes announce the new name (OSD) — the
  // auto-switch does not, it would chatter.
  const announcePresetRef = useRef(false);
  useEffect(() => {
    if (!announcePresetRef.current) return;
    announcePresetRef.current = false;
    showToast(presetLabel(presetKey));
  }, [presetKey, showToast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        pokeHud();
        // Esc only ever closes panels — leaving fullscreen is F's job, so a
        // stray Esc at a party never drops the picture out of fullscreen.
        if (regieOpen) setRegieOpen(false);
        // the studio handles its own Esc (it may ask about unsaved work)
        else if (studioKey !== null) return;
        else if (presetLibOpen) setPresetLibOpen(false);
        else if (tagFilterOpen) setTagFilterOpen(false);
        else if (tagBarOpen) setTagBarOpen(false);
        else if (cockpitOpen) setCockpitOpen(false);
        else if (libraryOpen) setLibraryOpen(false);
        else if (comfyOpen) setComfyOpen(false);
        else if (routingOpen) setRoutingOpen(false);
        else if (tweakOpen) setTweakOpen(false);
        else if (settingsOpen) setSettingsOpen(false);
        else if (helpOpen) setHelpOpen(false);
        return;
      }

      // Modal dialogs own the keyboard until they are dismissed. Prevent
      // shortcuts from changing the app behind their backdrop.
      if (libraryOpen || presetLibOpen || studioKey !== null || regieOpen) return;

      // Global shortcuts must never fire while somebody is typing or using a
      // native select/range control.
      if (isEditableTarget(e.target)) return;

      const m = modeRef.current;
      const b = matchKey(e, m);
      if (!b) {
        pokeHud();
        return;
      }
      if (b.preventDefault) e.preventDefault();
      // anything that opens a panel brings the controls back first
      if (b.opensUi && presentation) setPresentation(false);
      if (b.id !== "presentation") pokeHud();

      switch (b.id) {
        case "mode": {
          const next = VIZ_MODES[Number(e.key) - 1];
          setMode(next);
          showToast(VIZ_MODE_LABELS[next]);
          break;
        }
        case "fullscreen":
          void toggleFullscreen();
          break;
        case "presentation":
          if (presentation) {
            setPresentation(false);
            showToast("Bedienung wieder da");
          } else {
            setPresentation(true);
            setSettingsOpen(false);
            setCockpitOpen(false);
            setTagBarOpen(false);
            setTagFilterOpen(false);
            showToast("Präsentationsmodus · H holt die Bedienung zurück");
          }
          break;
        case "info":
          setInfoNonce((n) => n + 1);
          break;
        case "settings":
          toggleDrawer();
          break;
        case "cockpit":
          setCockpitOpen((v) => !v);
          break;
        case "regie":
          setRegieOpen(true);
          break;
        case "debug":
          setDebugOpen((v) => !v);
          break;
        case "help":
          setHelpOpen((v) => !v);
          break;
        case "prev":
        case "next": {
          const dir = b.id === "next" ? 1 : -1;
          if (m === "milkdrop") {
            announcePresetRef.current = true;
            stepPreset(dir);
          } else if (m === "3d") {
            const i = SCENE_NAMES.indexOf(sceneRef.current);
            const next = SCENE_NAMES[(i + dir + SCENE_NAMES.length) % SCENE_NAMES.length];
            setScene3d(next);
            showToast(next);
          }
          break;
        }
        case "random":
          announcePresetRef.current = true;
          randomPreset();
          break;
        case "auto":
          setAutoSwitch(!autoRef.current);
          showToast(autoRef.current ? "Auto-Wechsel aus" : "Auto-Wechsel an");
          break;
        case "fav": {
          const k = presetKeyRef.current;
          toggleFavorite(k);
          showToast(favorites.includes(k) ? `☆ ${presetLabel(k)}` : `★ ${presetLabel(k)}`);
          break;
        }
        case "library":
          setPresetLibOpen(true);
          break;
        case "studio":
          setStudioKey(presetKeyRef.current);
          break;
        case "tagbar":
          setTagBarOpen((v) => !v);
          break;
        case "layerB":
          if (!layerB.key) {
            if (presentation) setPresentation(false);
            setDrawerTab("layer");
            setSettingsOpen(true);
            showToast("Layer B: erst ein Preset wählen");
          } else {
            setLayerB((cfg) => ({ ...cfg, enabled: !cfg.enabled }));
            showToast(layerB.enabled ? "Layer B aus" : `Layer B: ${presetLabel(layerB.key)}`);
          }
          break;
        case "layerBSettings":
          setDrawerTab("layer");
          setSettingsOpen(true);
          break;
        case "queueClear":
          queue.clear();
          showToast("Queue geleert");
          break;
        case "queueAdd":
          queue.add(presetKeyRef.current);
          showToast(`+ Queue: ${presetLabel(presetKeyRef.current)}`);
          break;
        case "queueNext":
          if (!director.playNextQueued()) showToast("Queue ist leer");
          break;
        case "rateUp":
          ratePreset(1);
          break;
        case "rateDown":
          ratePreset(-1);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    toggleFullscreen,
    stepPreset,
    randomPreset,
    toggleFavorite,
    libraryOpen,
    comfyOpen,
    routingOpen,
    tweakOpen,
    settingsOpen,
    helpOpen,
    pokeHud,
    presetLibOpen,
    tagFilterOpen,
    tagBarOpen,
    cockpitOpen,
    regieOpen,
    showToast,
    drawerTab,
    studioKey,
    ratePreset,
    presentation,
    favorites,
    layerB,
  ]);

  const loopbacks = sources.filter((s) => s.kind === "loopback");
  const inputs = sources.filter((s) => s.kind === "input");
  const controlsVisible = !presentation && (hudVisible || hudPinned);

  return (
    <div
      className={`stage mode-${mode} ${
        supportsBgLayer(mode) && bgLayer !== "off" ? `bg-${bgLayer}` : ""
      } ${controlsVisible ? "" : "idle"} ${
        presentation || params.get("ui", "hideCursor") >= 0.5 ? "hide-cursor" : ""
      } ${presentation ? "presenting" : ""}`}
      data-ui={uiTier}
      onPointerMove={pokeHud}
      onPointerDown={pokeHud}
      onKeyDownCapture={pokeHud}
      onFocusCapture={pokeHud}
      onBlurCapture={pokeHud}
    >
      <canvas ref={mdCanvasRef} id="mdviz" aria-hidden="true" />
      <canvas
        ref={mdCanvasBRef}
        id="mdviz-b"
        aria-hidden="true"
        style={{
          visibility: mode === "milkdrop" && layerB.enabled && layerB.key ? "visible" : "hidden",
          mixBlendMode: layerB.blend as React.CSSProperties["mixBlendMode"],
          opacity: layerB.opacity,
        }}
      />
      <canvas ref={gl3dCanvasRef} id="viz3d" aria-hidden="true" />
      <canvas ref={canvasRef} id="viz" aria-hidden="true" />
      <div className="sr-only" aria-live="polite">
        Aktive Visualisierung: {VIZ_MODE_LABELS[mode]}
      </div>
      {debugOpen && <pre className="debug-hud" ref={debugElRef} />}
      {debugOpen && (
        <canvas
          className="freq-panel"
          ref={freqCanvasRef}
          aria-label="Frequenz-Analyse der eingehenden Audiosignale"
        />
      )}
      <div
        className={`hud ${controlsVisible ? "" : "hidden"}`}
        role="toolbar"
        aria-label="Vizzy-Steuerung"
      >
        <div className="hud-row">
          {params.get("ui", "showBrand") >= 0.5 && (
            <span className="brand">VIZZY</span>
          )}
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
          <div className="seg" role="group" aria-label="Visualisierung">
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
          </div>
          <button
            type="button"
            className={`icon-btn ${cockpitOpen ? "active" : ""}`}
            onClick={() => setCockpitOpen((v) => !v)}
            title={withKey("Cockpit: laufender Song", "cockpit")}
            aria-label="Cockpit öffnen"
            aria-pressed={cockpitOpen}
            aria-keyshortcuts="C"
          >
            ♪
          </button>
          <button
            ref={settingsButtonRef}
            type="button"
            className={`icon-btn ${settingsOpen ? "active" : ""}`}
            onClick={toggleDrawer}
            title={withKey("Einstellungen", "settings")}
            aria-label="Einstellungen öffnen"
            aria-pressed={settingsOpen}
            aria-controls="settings-panel"
            aria-keyshortcuts="E"
          >
            ⚙
          </button>
          <button
            ref={helpButtonRef}
            type="button"
            className={`icon-btn ${helpOpen ? "active" : ""}`}
            onClick={() => setHelpOpen((v) => !v)}
            title={withKey("Hilfe & Tastenkürzel", "help")}
            aria-label="Hilfe und Tastenkürzel öffnen"
            aria-pressed={helpOpen}
            aria-controls="help-panel"
            aria-keyshortcuts="?"
          >
            ?
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => void toggleFullscreen()}
            title={withKey("Vollbild", "fullscreen")}
            aria-label="Vollbild umschalten"
            aria-keyshortcuts="F"
          >
            ⛶
          </button>
        </div>
        {supportsBgLayer(mode) && bgLayer !== "off" && (
          <div className="hud-row hud-sub">
            <span className="demo-tag">
              Layer: {bgLayer} ⊕ {blendMode}
            </span>
            <button
              type="button"
              className="mode-btn"
              onClick={() => setBgLayer("off")}
              title="Hintergrund-Layer abschalten"
            >
              Layer aus
            </button>
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
            <button
              type="button"
              className="mode-btn"
              onClick={() => setPresetLibOpen(true)}
              title={withKey("Preset-Library mit Vorschauen", "library")}
              aria-keyshortcuts="L"
            >
              Library
            </button>
            <select
              className="src-select preset-select"
              value={presetKey}
              onChange={(e) => pickPreset(e.target.value)}
              title={presetKey}
              aria-label="Milkdrop-Preset"
            >
              {favorites.length > 0 && (
                <optgroup label="★ Favoriten">
                  {favorites.map((k) => (
                    <option key={`fav-${k}`} value={k}>
                      {presetLabel(k)}
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="✦ Vizzy — kuratiert">
                {CURATED.map((p) => (
                  <option
                    key={`${CURATED_PREFIX}${p.name}`}
                    value={`${CURATED_PREFIX}${p.name}`}
                  >
                    {p.name}
                  </option>
                ))}
              </optgroup>
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
                    {quarantine.includes(k) ? `⛔ ${k}` : k}
                  </option>
                ))}
              </optgroup>
            </select>
            <button
              type="button"
              className={`icon-btn star-btn ${isFavorite ? "active" : ""}`}
              onClick={() => toggleFavorite(presetKey)}
              title={
                isFavorite
                  ? withKey("Aus Favoriten entfernen", "fav")
                  : withKey("Zu Favoriten hinzufügen", "fav")
              }
              aria-label={
                isFavorite
                  ? "Preset aus Favoriten entfernen"
                  : "Preset zu Favoriten hinzufügen"
              }
              aria-pressed={isFavorite}
              aria-keyshortcuts="S"
            >
              {isFavorite ? "★" : "☆"}
            </button>
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
              title={withKey("Zufälliges Preset", "random")}
              aria-label="Zufälliges Preset"
              aria-keyshortcuts="R"
            >
              Zufall
            </button>
            <button
              type="button"
              className={`mode-btn ${autoSwitch ? "active" : ""}`}
              onClick={() => setAutoSwitch((v) => !v)}
              title={withKey("Auto-Wechsel bei Beats", "auto")}
              aria-label="Automatischen Preset-Wechsel umschalten"
              aria-pressed={autoSwitch}
              aria-keyshortcuts="A"
            >
              auto
            </button>
            <button
              type="button"
              className={`mode-btn ${favOnly ? "active" : ""}`}
              onClick={() => setFavOnly((v) => !v)}
              disabled={favorites.length === 0}
              title="Nur Favoriten durchblättern — gilt für ←/→, Zufall und Auto"
              aria-label="Nur Favoriten verwenden"
              aria-pressed={favOnly}
            >
              nur ★
            </button>
            <button
              type="button"
              className={`mode-btn ${tagFilter.length ? "active" : ""}`}
              onClick={() => setTagFilterOpen((v) => !v)}
              title="Nur Presets mit bestimmten Tags spielen — gilt für ←/→, Zufall und Auto"
              aria-expanded={tagFilterOpen}
            >
              {tagFilter.length ? `Tags: ${tagFilter.join(tagFilterMode === "all" ? " + " : " | ")}` : "Tags ▾"}
            </button>
            <button
              type="button"
              className={`mode-btn ${tagBarOpen ? "active" : ""}`}
              onClick={() => setTagBarOpen((v) => !v)}
              title={withKey("Laufendes Preset taggen", "tagbar")}
              aria-pressed={tagBarOpen}
              aria-keyshortcuts="T"
            >
              🏷
            </button>
            <button
              type="button"
              className={`mode-btn ${layerB.enabled && layerB.key ? "active" : ""}`}
              onClick={() => {
                if (!layerB.key) {
                  setDrawerTab("layer");
                  setSettingsOpen(true);
                } else {
                  setLayerB((cfg) => ({ ...cfg, enabled: !cfg.enabled }));
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setDrawerTab("layer");
                setSettingsOpen(true);
              }}
              title={
                layerB.key
                  ? `Layer B: ${presetLabel(layerB.key)} — Klick an/aus (B), Rechtsklick Einstellungen (Shift+B)`
                  : "Zweites Preset darüberlegen"
              }
              aria-pressed={layerB.enabled}
            >
              B
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
            <button
              type="button"
              className="mode-btn"
              onClick={() => setStudioKey(presetKey)}
              title={withKey("Preset-Studio: Bausteine mischen, Code bearbeiten, Remix", "studio")}
              aria-keyshortcuts="P"
            >
              Studio
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
            {scene3d === "parallax" && (
              <>
                {images.length > 0 && (
                  <select
                    className="mode-btn"
                    value={selectedImageId ?? ""}
                    onChange={(e) =>
                      void pickImage(
                        e.target.value === "" ? null : Number(e.target.value),
                      )
                    }
                    title="Gespeichertes Bild wählen (◆ = mit gebackener Tiefenkarte)"
                  >
                    <option value="">— Platzhalter —</option>
                    {images.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.hasDepth ? "◆ " : "◇ "}
                        {i.name}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  type="button"
                  className="mode-btn"
                  onClick={() => imageInputRef.current?.click()}
                  title="Bild laden (PNG/JPG/WebP)"
                >
                  Bild +
                </button>
                <button
                  type="button"
                  className="mode-btn"
                  disabled={selectedImageId == null}
                  onClick={() => depthInputRef.current?.click()}
                  title="Fertige Tiefenkarte als Datei zum aktuellen Bild laden. Ohne sie läuft die Szene auf einer grob geschätzten Tiefe."
                >
                  Tiefenkarte +
                </button>
                <button
                  type="button"
                  className="mode-btn"
                  disabled={selectedImageId == null}
                  onClick={() => {
                    setBakeKind("depth");
                    setBakeState({ kind: "idle" });
                    setComfyOpen(true);
                  }}
                  title="Tiefenkarte in ComfyUI backen"
                >
                  {bakeState.kind === "running" ? "backt…" : "Backen ✨"}
                </button>
                {selectedImageId != null && (
                  <button
                    type="button"
                    className="mode-btn danger"
                    onClick={() => void removeImage(selectedImageId)}
                    title="Bild aus der Library löschen"
                  >
                    ✕
                  </button>
                )}
              </>
            )}
            {scene3d === "morph" && (
              <>
                {morphSets.length > 0 && (
                  <select
                    className="mode-btn"
                    value={selectedMorphId ?? ""}
                    onChange={(e) =>
                      void pickMorphSet(
                        e.target.value === "" ? null : Number(e.target.value),
                      )
                    }
                    title="Gespeicherten Varianten-Satz wählen"
                  >
                    <option value="">— Platzhalter —</option>
                    {morphSets.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.frameCount}× {m.name}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  type="button"
                  className="mode-btn"
                  onClick={() => morphInputRef.current?.click()}
                  title={`Varianten laden — mehrere Bilder auf einmal, nach Dateiname sortiert (max. ${MAX_FRAMES}). Gleicher Seed, variierende Stimmung.`}
                >
                  Varianten +
                </button>
                <button
                  type="button"
                  className="mode-btn"
                  disabled={selectedImageId == null}
                  onClick={() => {
                    setBakeKind("variants");
                    setBakeState({ kind: "idle" });
                    setComfyOpen(true);
                  }}
                  title={
                    selectedImageId == null
                      ? "Quellbild fehlt — erst „Bild +“ in der Parallax-Szene laden"
                      : "Varianten aus dem Parallax-Bild in ComfyUI backen"
                  }
                >
                  {bakeState.kind === "running" ? "backt…" : "Backen ✨"}
                </button>
                {selectedMorphId != null && (
                  <button
                    type="button"
                    className="mode-btn danger"
                    onClick={() => void removeMorphSet(selectedMorphId)}
                    title="Satz aus der Library löschen"
                  >
                    ✕
                  </button>
                )}
              </>
            )}
            <input
              ref={morphInputRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: "none" }}
              onChange={onMorphFiles}
            />
            <input
              ref={fileInputRef}
              type="file"
              accept=".glb,.gltf,.zip"
              style={{ display: "none" }}
              onChange={onModelFile}
            />
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={onImageFile}
            />
            <input
              ref={depthInputRef}
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={onDepthFile}
            />
          </div>
        )}
      </div>
      {settingsOpen && (
        <SettingsPanel
          paramGroups={[
            mode === "3d" ? scene3d : mode,
            ...(mode === "3d" ? ["md3d"] : []),
            ...(supportsBgLayer(mode) && bgLayer !== "off" ? ["layer"] : []),
          ]}
          milkdropAvailable={mode === "milkdrop"}
          sources={sources}
          apps={apps}
          selectedSource={selected}
          onSelectSource={(v) => void selectSource(v)}
          onRefreshSources={loadLists}
          uiScale={uiScale}
          uiScales={UI_SCALES}
          uiScaleLabels={UI_SCALE_LABELS}
          onUiScale={(v) => setUiScale(v as UiScalePref)}
          showBpm={showBpm}
          onShowBpm={setShowBpm}
          debugOpen={debugOpen}
          onDebug={setDebugOpen}
          presentation={presentation}
          onPresentation={(on) => {
            setPresentation(on);
            if (on) {
              setSettingsOpen(false);
              setCockpitOpen(false);
              showToast("Präsentationsmodus · H holt die Bedienung zurück");
            }
          }}
          bgLayer={bgLayer}
          bgLayers={BG_LAYERS}
          onBgLayer={(v) => setBgLayer(v as BgLayer)}
          blendMode={blendMode}
          blendModes={BLEND_MODES}
          onBlendMode={(v) => setBlendMode(v as BlendMode)}
          showLayerControls={supportsBgLayer(mode)}
          autoSwitch={autoSwitch}
          onAutoSwitch={setAutoSwitch}
          favOnly={favOnly}
          onFavOnly={setFavOnly}
          favorites={favorites}
          onPickPreset={(k) => {
            setPresetKey(k);
            setMode("milkdrop");
          }}
          onUnfavorite={toggleFavorite}
          userPresets={userPresets}
          onDeleteUserPreset={removeUserPreset}
          onOpenRouting={() => setDrawerTab("routing")}
          onOpenTweaks={() => setDrawerTab("tweaks")}
          onResetAll={resetAll}
          onClose={() => setSettingsOpen(false)}
          returnFocusRef={settingsButtonRef}
          tab={drawerTab}
          onTab={setDrawerTab}
          extraTabs={[
            ...(mode === "milkdrop"
              ? [
                  {
                    id: "tweaks",
                    label: "Tweaks",
                    after: "milkdrop" as const,
                    content: (
                      <MdTweakPanel
                        key={presetKey}
                        presetKey={presetKey}
                        baseVals={currentBaseVals}
                        overrides={mdOverrides}
                        onChange={(key, value) =>
                          setMdOverrides((prev) => ({ ...prev, [key]: value }))
                        }
                        onReset={() => setMdOverrides({})}
                        onResetKey={(key) =>
                          setMdOverrides((prev) => {
                            const next = { ...prev };
                            delete next[key];
                            return next;
                          })
                        }
                        onSave={saveTweaks}
                        onDeleteUser={removeUserPreset}
                      />
                    ),
                  },
                ]
              : []),
            ...(mode === "milkdrop"
              ? [
                  {
                    id: "layer",
                    label: "Layer",
                    after: "milkdrop" as const,
                    content: (
                      <LayerPanel
                        cfg={layerB}
                        onChange={setLayerB}
                        presetKeys={allPresetKeys}
                        label={presetLabel}
                        currentKey={presetKey}
                        error={layerBError}
                        offerUndo={offerUndo}
                        onPickFromLibrary={() => {
                          setLibTarget("b");
                          setPresetLibOpen(true);
                        }}
                        onSwap={() => {
                          const a = presetKey;
                          setPresetKey(layerB.key);
                          setLayerB((cfg) => ({ ...cfg, key: a }));
                        }}
                        onRestore={(a, b) => {
                          setPresetKey(a);
                          setLayerB(b);
                        }}
                      />
                    ),
                  },
                ]
              : []),
            {
              id: "routing",
              label: "Routing",
              after: "audio" as const,
              content: <RoutingModal embedded onClose={() => setSettingsOpen(false)} />,
            },
            ...(comfyOpen || (mode === "3d" && (scene3d === "parallax" || scene3d === "morph"))
              ? [
                  {
                    id: "comfy",
                    label: "ComfyUI",
                    after: "bild" as const,
                    content: (
                      <ComfyPanel
                              kind={bakeKind}
                              onKindChange={(k) => {
                                setBakeKind(k);
                                setBakeState({ kind: "idle" });
                              }}
                              url={comfyUrl}
                              onUrlChange={(u) => {
                                setComfyUrl(u);
                                saveComfyUrl(u);
                              }}
                              axes={axes}
                              onAxesChange={(a) => {
                                setAxes(a);
                                saveAxes(a);
                              }}
                              workflow={workflows[bakeKind]}
                              onWorkflowChange={(json) => {
                                setWorkflows((prev) => ({ ...prev, [bakeKind]: json }));
                                saveWorkflow(bakeKind, json);
                              }}
                              imageName={
                                images.find((i) => i.id === selectedImageId)?.name ?? null
                              }
                              bake={bakeState}
                              onBake={() => void runBake()}
                              onClose={() => setSettingsOpen(false)}
                              embedded
                            />
                    ),
                  },
                ]
              : []),
            {
              id: "help",
              label: "Hilfe",
              content: (
                <HelpPanel
                  embedded
                  onClose={() => setSettingsOpen(false)}
                  returnFocusRef={helpButtonRef}
                />
              ),
            },
          ]}
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
      {tagFilterOpen && mode === "milkdrop" && (
        <div className="tagfilter-pop" role="dialog" aria-label="Tag-Filter">
          <div className="tagfilter-head">
            <span>Nur Presets mit</span>
            <button
              type="button"
              className="chip"
              onClick={() => setTagFilterMode((m) => (m === "any" ? "all" : "any"))}
              title="ODER: irgendeiner der Tags · UND: alle"
            >
              {tagFilterMode === "any" ? "einem davon (ODER)" : "allen (UND)"}
            </button>
            {tagFilter.length > 0 && (
              <button type="button" className="chip" onClick={() => setTagFilter([])}>
                × aus
              </button>
            )}
            <button type="button" className="mode-btn" onClick={() => setTagFilterOpen(false)}>
              ×
            </button>
          </div>
          <TagChips
            compact
            selected={tagFilter}
            onToggle={(t) =>
              setTagFilter((f) => (f.includes(t) ? f.filter((x) => x !== t) : [...f, t]))
            }
          />
          <div className="tagfilter-count">{browseKeys.length} Presets in der Rotation</div>
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
      {mode === "3d" && scene3d === "morph" && selectedMorphId == null && (
        <div className="scene-empty" role="note">
          <span>Noch kein Varianten-Satz — das hier ist der Platzhalter.</span>
          <button type="button" className="mode-btn" onClick={() => morphInputRef.current?.click()}>
            Varianten laden
          </button>
          <button
            type="button"
            className="mode-btn"
            disabled={selectedImageId == null}
            title={selectedImageId == null ? "Erst in der Parallax-Szene ein Bild laden" : undefined}
            onClick={() => {
              setBakeKind("variants");
              setBakeState({ kind: "idle" });
              setComfyOpen(true);
            }}
          >
            Aus Parallax-Bild backen ✨
          </button>
        </div>
      )}
      {mode === "3d" && scene3d === "model" && selectedModelId == null && (
        <div className="scene-empty" role="note">
          <span>Noch kein Modell gewählt.</span>
          <button
            type="button"
            className="mode-btn"
            onClick={() => {
              refreshModels();
              setLibraryOpen(true);
            }}
          >
            Modell-Library öffnen
          </button>
        </div>
      )}
      <InfoOverlay
        nonce={infoNonce}
        picture={
          mode === "milkdrop"
            ? presetLabel(presetKey)
            : mode === "3d"
              ? `3D · ${scene3d}`
              : VIZ_MODE_LABELS[mode]
        }
      />
      {undo && (
        <div className="toast toast-undo" role="status">
          <span>{undo.msg}</span>
          <button type="button" className="mode-btn" onClick={runUndo}>
            Rückgängig
          </button>
        </div>
      )}
      {cockpitOpen && (
        <Cockpit
          presetKey={presetKey}
          canAssign={mode === "milkdrop"}
          presetLabel={mode === "milkdrop" ? presetLabel(presetKey) : VIZ_MODE_LABELS[mode]}
          autoSwitch={mode === "milkdrop" && autoSwitch}
          onClose={() => setCockpitOpen(false)}
          onOpenRegie={() => setRegieOpen(true)}
        />
      )}
      {mode === "milkdrop" && <QueueBar label={presetLabel} autoSwitch={autoSwitch} />}
      {regieOpen && (
        <RegieModal
          presetKeys={allPresetKeys}
          label={presetLabel}
          currentKey={presetKey}
          onPlay={(k) => {
            setPresetKey(k);
            if (mode !== "milkdrop") setMode("milkdrop");
          }}
          onClose={() => setRegieOpen(false)}
        />
      )}
      {tagBarOpen && mode === "milkdrop" && (
        <TagBar
          presetKey={presetKey}
          label={presetLabel(presetKey)}
          onClose={() => setTagBarOpen(false)}
        />
      )}
      {studioKey !== null && (
        <PresetStudio
          initialKey={studioKey}
          allKeys={allPresetKeys}
          favorites={favorites}
          label={presetLabel}
          resolvePreset={resolvePreset}
          onApply={(k) => {
            setPresetKey(k);
            if (mode !== "milkdrop") setMode("milkdrop");
            setStudioKey(null);
          }}
          onClose={() => setStudioKey(null)}
        />
      )}
      {presetLibOpen && (
        <PresetLibrary
          entries={catalog}
          currentKey={presetKey}
          favorites={favorites}
          quarantine={quarantine}
          runtimeReady={milkdropStatus === "ready"}
          resolvePreset={resolvePreset}
          onApply={(k, ov) => {
            if (libTarget === "b") {
              setLayerB((cfg) => ({ ...cfg, key: k, enabled: true }));
              setPresetLibOpen(false);
              setLibTarget("a");
            } else {
              applyFromLibrary(k, ov);
            }
            if (mode !== "milkdrop") setMode("milkdrop");
          }}
          onApplyLayerB={(k) => setLayerB((cfg) => ({ ...cfg, key: k, enabled: true }))}
          onOpenStudio={(k) => {
            setPresetLibOpen(false);
            setStudioKey(k);
          }}
          target={libTarget}
          onToggleFavorite={toggleFavorite}
          onClose={() => {
            setPresetLibOpen(false);
            setLibTarget("a");
          }}
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
  onAutoSwitch: (reason?: "auto" | "trap" | "skip") => void,
  onQuarantine: (key: string) => void,
  bpmEl: { current: HTMLSpanElement | null },
  modelRef: { current: ModelAction | null },
  imageRef: { current: ImageAction | null },
  morphRef: { current: MorphAction | null },
  camResetRef: { current: number },
  bgLayerRef: { current: BgLayer },
  blendRef: { current: BlendMode },
  overridesRef: { current: { version: number; map: Record<string, number> } },
  resolveRef: { current: (key: string) => unknown | null },
  debugEl: { current: HTMLPreElement | null },
  freqCanvas: { current: HTMLCanvasElement | null },
  mdCanvasB: { current: HTMLCanvasElement | null },
  layerBRef: { current: LayerBConfig },
  onLayerBError: (msg: string) => void,
  /** performance.now() of the last picture the Regie director put up */
  directorSwitchAt: { current: number },
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
  // musical position tracked by the Rust phrasing module
  let beatPhase = 0;
  let beatCount = 0;
  let barPhase = 0;
  let phrasePhase = 0;
  let section = 0;
  let gridConf = 0;
  let prevBeat = 0;
  let prevSection = 0;
  let prevBoundary = -1;
  let prevSpectroBeat = 0;
  let prevSpectroBeatIdx = -1;
  let spectroCol: ImageData | null = null;
  let lastAutoSwitch = 0;

  // smoothed display state
  let disp = new Float32Array(bands.length);
  let peaks = new Float32Array(bands.length);

  // 3D state (lazy)
  let viz3d: Viz3D | null = null;
  let viz3dLoading: Promise<void> | null = null;
  let viz3dFailed = false;
  let loadedModelSeq = 0;
  let loadedImageSeq = 0;
  let loadedMorphSeq = 0;
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
          viz3d.setMilkdropCanvas(mdCanvas);
          // debug hook: lets the debug HUD / devtools poke the live scene
          (window as unknown as Record<string, unknown>).__viz3d = viz3d;
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
      const img = imageRef.current;
      if (img && img.seq !== loadedImageSeq) {
        loadedImageSeq = img.seq;
        if (img.action === "load") viz3d.loadImage(img.asset);
        else viz3d.clearImage();
      }
      const set = morphRef.current;
      if (set && set.seq !== loadedMorphSeq) {
        loadedMorphSeq = set.seq;
        if (set.action === "load") viz3d.loadMorph(set.asset);
        else viz3d.clearMorph();
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
  let lastMdRender = 0;
  const timeByte = new Uint8Array(1024).fill(128);

  // --- recovery from a preset that traps --------------------------------
  // Butterchurn runs preset equations as WASM, where turning NaN or a huge
  // float into an integer (`%`, `megabuf(i)`, `loop(n, …)`) is a hard trap
  // rather than a silent 0. A preset whose state has gone bad — a physics
  // sim that blew up, say — then traps on every frame, forever, because the
  // bad numbers sit in its memory. Reloading the preset runs its init code
  // again and clears them; one that keeps doing it gets skipped.
  const TRAP_WINDOW_MS = 30_000;
  const TRAPS_BEFORE_SKIP = 3;
  let bcHeld = false; // rendering paused until a clean preset is loaded
  let bcHardLoad = false; // next load must not blend from the broken preset
  let bcTrapKey = "";
  let bcTrapAt = 0;
  let bcTraps = 0;
  let bcSkipDeadline = 0;

  function onMilkdropTrap(e: unknown) {
    const now = performance.now();
    const again = bcLoadedPreset === bcTrapKey && now - bcTrapAt < TRAP_WINDOW_MS;
    bcTraps = again ? bcTraps + 1 : 1;
    bcTrapKey = bcLoadedPreset;
    bcTrapAt = now;
    bcHeld = true;
    bcHardLoad = true;
    if (bcTraps < TRAPS_BEFORE_SKIP) {
      flog(`[md] render FAILED (${bcTrapKey}): ${e} — reloading preset`);
      bcLoadedPreset = ""; // same key, fresh state
    } else {
      flog(
        `[md] render FAILED (${bcTrapKey}): ${e} — keeps failing, quarantined`,
      );
      onQuarantine(bcTrapKey);
      lastAutoSwitch = now;
      bcSkipDeadline = now + 1500;
      onAutoSwitch("trap");
    }
  }

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

  /** Beats between switches per `switchOn` mode; 0 = not grid-based. */
  const SWITCH_BEATS = [0, 4, 8, 16, 32, 0];

  /** Which N-beat bucket of the current phrase we are in. It ticks over
   *  exactly on the chosen boundary, and because it is derived from the
   *  phrase phase the buckets line up with real bars — not with an arbitrary
   *  beat count that happened to start when the app did. */
  function currentBoundary(): number {
    const every = SWITCH_BEATS[params.get("milkdrop", "switchOn") | 0] ?? 16;
    if (every === 0) return -1;
    return Math.floor((phrasePhase * 32) / every);
  }

  function wantsAutoSwitch(): boolean {
    if (
      performance.now() - Math.max(lastAutoSwitch, directorSwitchAt.current) <
      params.get("milkdrop", "cooldown") * 1000
    ) {
      return false;
    }
    const mode = params.get("milkdrop", "switchOn") | 0;
    // The section pulse decays in ~0.4 s; testing well below the peak keeps a
    // dropped IPC frame from swallowing the whole transition.
    if (mode === 5) return section >= 0.7 && prevSection < 0.7;
    // Without a trustworthy grid there are no boundaries to hit — fall back
    // to the plain onset trigger rather than never switching at all.
    if (mode === 0 || gridConf < GRID_LOCKED) return beat >= 0.95 && prevBeat < 0.95;
    const b = currentBoundary();
    return prevBoundary !== -1 && b !== prevBoundary;
  }

  function renderMilkdrop() {
    if (!ensureButterchurn() || !bc) return;
    if (mdCanvas.width === 0 || mdCanvas.height === 0) return;

    // Auto preset switching. The cooldown is a *minimum* wait, not the
    // interval: once it has elapsed the switch is held until the music
    // reaches the chosen boundary, so presets change in time with the track
    // instead of whenever the timer happens to run out.
    // A filled live queue advances on the same boundaries, auto or not.
    if ((autoRef.current || queue.length > 0) && wantsAutoSwitch()) {
      lastAutoSwitch = performance.now();
      onAutoSwitch();
    }
    prevBeat = beat;
    prevSection = section;
    prevBoundary = currentBoundary();

    const want = presetKeyRef.current;
    const ov = overridesRef.current;
    if (bcSkipDeadline && performance.now() > bcSkipDeadline) {
      // Asked for another preset after repeated traps and none arrived
      // (a favourites list of one, say) — start this one over instead of
      // standing still.
      bcSkipDeadline = 0;
      if (bcHeld && want === bcLoadedPreset) {
        bcLoadedPreset = "";
        bcTraps = 0;
      }
    }
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
            // Blending keeps the outgoing preset's equations running, so
            // after a trap the switch has to be a hard cut.
            const loading: unknown = bc.loadPreset(
              preset,
              keyChanged && bcEverLoaded && !bcHardLoad
                ? params.get("milkdrop", "blend")
                : 0,
            );
            bcEverLoaded = true;
            if (keyChanged) flog(`[md] preset: ${want}`);
            if (bcHardLoad) {
              // WASM presets compile asynchronously; until that is done the
              // broken one is still the one that would render.
              bcHardLoad = false;
              bcSkipDeadline = 0;
              void Promise.resolve(loading)
                .catch((e) => flog(`[md] loadPreset FAILED (${want}): ${e}`))
                .then(() => {
                  bcHeld = false;
                });
            }
          } catch (e) {
            bcHeld = false;
            bcHardLoad = false;
            flog(`[md] loadPreset FAILED (${want}): ${e}`);
          }
        }
      }
    }

    // Sensitivity applies to the waveform butterchurn analyzes, too — and
    // that waveform is the only lever we have on a preset once it is loaded,
    // since its equations run inside butterchurn. Shaping the level by
    // musical position therefore makes any preset breathe with the phrase,
    // smoothly and without reloading (a reload would restart its motion).
    const dyn = params.get("milkdrop", "phraseDyn");
    let envelope = 1;
    if (dyn > 0 && gridConf >= GRID_LOCKED) {
      const swell = 0.8 + 0.4 * phrasePhase; // builds across the 32 beats
      const accent = 1 + 0.5 * Math.pow(1 - barPhase, 5); // lands on the one
      envelope = 1 + dyn * (swell * accent - 1);
    }
    const gain = params.get("audio", "gain") * envelope;
    const n = Math.min(wave.length, timeByte.length);
    for (let j = 0; j < n; j++) {
      const v = Math.max(-1, Math.min(1, wave[j] * gain));
      timeByte[j] = (v * 127 + 128) | 0;
    }
    const lb = layerBRef.current;
    if (lb.enabled && lb.bandA) shapeWave(timeByte, lb.bandA, 1, timeByte);
    if (bcHeld) return; // the last good frame stays up while a reload lands

    // Butterchurn's own clock accepts frame times up to a full second. One
    // stall that long (a bake, a preset compiling, the window coming back)
    // is enough to send a preset's physics off to infinity, so it gets the
    // same 100 ms ceiling the rest of the app uses.
    const nowMs = performance.now();
    const elapsedTime = Math.min(Math.max((nowMs - lastMdRender) / 1000, 0.001), 0.1);
    lastMdRender = nowMs;
    try {
      bc.render({
        audioLevels: {
          timeByteArray: timeByte,
          timeByteArrayL: timeByte,
          timeByteArrayR: timeByte,
        },
        elapsedTime,
      });
    } catch (e) {
      onMilkdropTrap(e);
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
      live.bpm = bpm;
      bpmConf = f[7];
      beatPhase = f[8];
      beatCount = f[9];
      barPhase = f[10];
      phrasePhase = f[11];
      section = f[12];
      gridConf = f[13];
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

  // Fake data for the plain-browser preview (no Tauri IPC). It synthesizes an
  // actual little track — kick, bassline, hats, pad — rather than a smooth
  // drone, because Milkdrop presets are driven by transients: fed a steady
  // tone they barely move, and the preview looks nothing like the real thing.
  const MOCK_BPM = 128;
  const MOCK_SR = 48000;
  /** bass note per bar, a slow four-chord loop in semitones */
  const MOCK_NOTES = [55, 55, 62, 58];

  function mockFrame(t: number) {
    const TAU = Math.PI * 2;
    const beatDur = 60 / MOCK_BPM;
    const beats = t / beatDur;
    const bar = Math.floor(beats / 4);

    // envelopes at *this* moment, for the band spectrum and the meters
    const inBeat = beats % 1;
    const inEighth = (beats * 2) % 1;
    const kickNow = Math.exp(-inBeat * 13);
    const hatNow = Math.exp(-inEighth * 38) * (inEighth < 0.5 ? 0.55 : 0.85);
    const snareNow = Math.floor(beats) % 2 === 1 ? Math.exp(-inBeat * 15) : 0;
    // slow build over each 32-beat phrase, dropping back at the top
    const build = 0.55 + 0.45 * ((beats % 32) / 32);

    const hz = 55 * Math.pow(2, (MOCK_NOTES[bar % MOCK_NOTES.length] - 55) / 12);

    for (let j = 0; j < wave.length; j++) {
      const s = t + j / MOCK_SR;
      const bt = (s / beatDur) % 1;
      const et = ((s / beatDur) * 2) % 1;

      // kick: short body with a falling pitch, the thing presets react to
      const kEnv = Math.exp(-bt * 13);
      const kHz = 48 + 110 * Math.exp(-bt * 26);
      let v = 0.62 * kEnv * Math.sin(TAU * kHz * s);

      // bassline + a couple of harmonics for the mids
      v += 0.2 * Math.sin(TAU * hz * s) * (0.55 + 0.45 * kEnv);
      v += 0.09 * Math.sin(TAU * hz * 3 * s + Math.sin(s * 0.6));
      v += 0.05 * Math.sin(TAU * hz * 5 * s);

      // hats: cheap deterministic noise, louder on the off-beat
      const hEnv = Math.exp(-et * 38) * (et < 0.5 ? 0.55 : 0.85);
      v += 0.16 * hEnv * Math.sin(s * 91393.7);

      // snare on 2 and 4
      if (Math.floor(s / beatDur) % 2 === 1) {
        v += 0.22 * Math.exp(-bt * 15) * Math.sin(s * 47221.3);
      }

      wave[j] = Math.max(-1, Math.min(1, v * build));
    }

    // Bands shaped to match: lows follow the kick, highs the hats, mids the
    // sustained tone — so the bar visualizations and the waveform agree.
    for (let i = 0; i < bands.length; i++) {
      const f = i / bands.length; // 0 = low, 1 = high
      const low = Math.exp(-f * 9);
      const mid = Math.exp(-Math.pow((f - 0.42) * 3.4, 2));
      const high = Math.exp(-Math.pow((f - 0.82) * 4.5, 2));
      bands[i] = Math.min(
        1,
        (kickNow * low * 1.15 +
          (0.42 + 0.2 * Math.sin(t * 0.9 + f * 6)) * mid +
          (hatNow + snareNow * 0.6) * high * 0.95 +
          0.04) *
          build,
      );
    }

    rms = (0.12 + 0.3 * kickNow + 0.08 * hatNow) * build;
    peak = Math.min(1, rms * 2.4);
    beat = Math.pow(kickNow, 1.5);
    flux = beat * 0.7;
    bpm = MOCK_BPM;
    bpmConf = 0.9;

    // a perfectly steady fake grid, so phrase-driven behaviour is testable
    // in the plain-browser preview too
    beatCount = Math.floor(beats);
    beatPhase = inBeat;
    barPhase = (beats % 4) / 4;
    phrasePhase = (beats % 32) / 32;
    gridConf = 0.9;
    // a "section change" every 32 s, decaying like the real pulse
    section = Math.max(0, 1 - (t % 32) / 0.4);
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
  let layerB: LayerB | null = null;
  let lastLayerBError = "";
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

    // shared with the library tile and the tag-driven auto-switch
    live.update(rms, section, phrasePhase, gridConf, dt);
    // song choreos fire their cues, the song analysis records (Regie)
    director.tick();
    {
      const g = params.get("audio", "gain");
      const n = Math.min(wave.length, liveTimeByte.length);
      for (let j = 0; j < n; j++) {
        const v = Math.max(-1, Math.min(1, wave[j] * g));
        liveTimeByte[j] = (v * 127 + 128) | 0;
      }
    }

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
      const lb = layerBRef.current;
      if (lb.enabled && lb.key && mdCanvasB.current) {
        layerB ??= new LayerB(mdCanvasB.current);
        layerB.render(lb, (k) => resolveRef.current(k), 0, params.get("milkdrop", "blend"));
        if (layerB.error !== lastLayerBError) {
          lastLayerBError = layerB.error;
          onLayerBError(lastLayerBError);
        }
      }
    } else if (modeRef.current === "3d") {
      // scenes that use the Milkdrop picture need it rendered first
      if (viz3d?.wantsMilkdrop()) renderMilkdrop();
      render3D(dt, now / 1000);
    } else {
      // layered background under the 2D visualization (the waterfall paints
      // every pixel itself, so it never gets one)
      if (supportsBgLayer(modeRef.current)) {
        if (bgLayerRef.current === "milkdrop") renderMilkdrop();
        else if (bgLayerRef.current === "3d") render3D(dt, now / 1000);
      }
      draw();
    }
    applyLayerStyles(supportsBgLayer(modeRef.current));

    const el = bpmEl.current;
    if (el) {
      const text =
        bpmConf > 0.3 && bpm > 40 ? `${Math.round(bpm)} BPM` : "· · ·";
      if (el.textContent !== text) el.textContent = text;
      // Once the grid is locked the badge ticks with it — a steady metronome
      // that rides through missed onsets instead of stuttering on them.
      const pulse =
        gridConf >= GRID_LOCKED ? Math.pow(1 - beatPhase, 3) : beat;
      el.style.transform = `scale(${(1 + pulse * 0.15).toFixed(3)})`;
    }

    updateDebugHud(now, cap);
    drawFreqPanel(dt);

    raf = requestAnimationFrame(frame);
  }

  // Frequency-analysis panel (debug mode): live spectrum with peak hold,
  // waveform strip and a beat/flux history lane — the incoming audio at a
  // glance, independent of whatever the current visualization shows.
  const freqPeaks = new Float32Array(64);
  const beatHist = new Float32Array(240); // ~4 s at 60fps
  const fluxHist = new Float32Array(240);
  let histIdx = 0;
  function drawFreqPanel(dt: number) {
    const el = freqCanvas.current;
    if (!el) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = el.clientWidth || 300;
    const cssH = el.clientHeight || 200;
    const W = Math.round(cssW * dpr);
    const H = Math.round(cssH * dpr);
    if (el.width !== W || el.height !== H) {
      el.width = W;
      el.height = H;
    }
    const g = el.getContext("2d");
    if (!g) return;

    histIdx = (histIdx + 1) % beatHist.length;
    beatHist[histIdx] = beat;
    fluxHist[histIdx] = flux;

    g.clearRect(0, 0, W, H);
    const pad = 8 * dpr;
    const specH = H * 0.52;
    const waveH = H * 0.2;
    const histH = H - specH - waveH - pad * 2;

    // --- spectrum: 64 bands, log-ish palette, peak-hold caps -------------
    const n = bands.length || 64;
    const bw = (W - pad * 2) / n;
    for (let i = 0; i < n; i++) {
      const v = bands[i] ?? 0;
      if (v > freqPeaks[i]) freqPeaks[i] = v;
      else freqPeaks[i] = Math.max(0, freqPeaks[i] - dt * 0.35);
      const h = v * (specH - pad);
      const hue = 200 - (i / n) * 160; // cyan lows -> pink highs
      g.fillStyle = `hsl(${hue} 85% ${35 + v * 30}%)`;
      g.fillRect(pad + i * bw, specH - h, Math.max(bw - 1, 1), h);
      const ph = freqPeaks[i] * (specH - pad);
      g.fillStyle = "rgba(226, 232, 240, 0.8)";
      g.fillRect(pad + i * bw, specH - ph - 1.5 * dpr, Math.max(bw - 1, 1), 1.5 * dpr);
    }
    g.fillStyle = "rgba(148, 163, 184, 0.75)";
    g.font = `${9 * dpr}px ui-monospace, monospace`;
    g.fillText("40 Hz", pad, specH + 10 * dpr);
    g.fillText("16 kHz", W - pad - 34 * dpr, specH + 10 * dpr);

    // --- waveform strip ---------------------------------------------------
    const wy = specH + pad;
    g.strokeStyle = "#7dd3fc";
    g.lineWidth = 1.2 * dpr;
    g.beginPath();
    for (let j = 0; j < wave.length; j += 2) {
      const x = pad + (j / (wave.length - 1)) * (W - pad * 2);
      const y = wy + waveH * 0.5 + (wave[j] ?? 0) * waveH * 0.48;
      if (j === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();

    // --- beat env + flux history ------------------------------------------
    const hy = wy + waveH + pad;
    g.fillStyle = "rgba(148, 163, 184, 0.25)";
    g.fillRect(pad, hy, W - pad * 2, 1);
    for (let k = 0; k < beatHist.length; k++) {
      const idx = (histIdx + 1 + k) % beatHist.length;
      const x = pad + (k / (beatHist.length - 1)) * (W - pad * 2);
      const bv = beatHist[idx];
      const fv = fluxHist[idx];
      if (fv > 0.01) {
        g.fillStyle = "rgba(251, 191, 36, 0.55)";
        g.fillRect(x, hy + histH - fv * histH, 1.5 * dpr, fv * histH);
      }
      if (bv > 0.01) {
        g.fillStyle = "rgba(129, 140, 248, 0.9)";
        g.fillRect(x, hy + histH - bv * histH, 1 * dpr, 2 * dpr);
      }
    }
    g.fillStyle = "#a5b4fc";
    g.fillText(
      `beat/flux · bpm ${bpm.toFixed(0)} (${(bpmConf * 100).toFixed(0)}%)`,
      pad,
      hy + histH - 3 * dpr,
    );
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
      gridConf >= GRID_LOCKED
        ? `takt ${(Math.round(barPhase * 4) % 4) + 1}/4 · phrase ` +
          `${(Math.round(phrasePhase * 32) % 32) + 1}/32 · ` +
          `grid ${gridConf.toFixed(2)}${section > 0.05 ? " · SEKTION" : ""}`
        : `grid nicht eingerastet (${gridConf.toFixed(2)})`,
      `energie ${ENERGY_LEVELS[live.level]} (${live.norm.toFixed(2)}) · ` +
        `tags ${["aus", "sanft", "streng"][params.get("milkdrop", "tagMode") | 0]}`,
      live.lastPick || "auto: noch keine Wahl",
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

    if (modeRef.current === "spektro") {
      // the waterfall keeps its own history — no trail clear, no beat flash
      drawSpectro(w, h, dpr);
    } else {
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
    }

    if (params.get("ui", "showFps") >= 0.5) {
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
  }

  // --- Spektrogramm (waterfall) ----------------------------------------
  // Time scrolls right-to-left, frequency runs bottom (bass) to top. The
  // canvas *is* the history buffer: every frame the existing picture is
  // blitted a few pixels to the left and only the freshly freed column is
  // painted. Optionally a live bar spectrum sits in a strip on the right,
  // outside the scrolled region so it never smears into the history.

  // Colour ramps as RGB stops, interpolated per sample. Every ramp starts at
  // near-black so quiet passages stay dark and the loud parts pop — that
  // contrast is what makes a spectrogram readable.
  const SPECTRO_RAMPS: number[][][] = [
    // inferno — black → purple → orange → pale yellow
    [[0, 0, 4], [40, 11, 84], [120, 28, 109], [190, 55, 84], [237, 121, 83], [252, 255, 164]],
    // ice — near-black blue → cyan → white
    [[2, 4, 20], [10, 40, 90], [20, 110, 170], [60, 190, 220], [190, 240, 250], [255, 255, 255]],
    // retro analyser — the old green/yellow/red bar colours
    [[0, 6, 2], [0, 90, 20], [40, 180, 40], [210, 220, 40], [240, 140, 30], [250, 40, 40]],
    // neon — violet → magenta → white
    [[6, 0, 16], [60, 10, 90], [130, 20, 160], [220, 40, 180], [255, 120, 220], [255, 255, 255]],
  ];

  /** value 0..1 → [r, g, b] on the given ramp. */
  function spectroRgb(v: number, ramp: number[][]): [number, number, number] {
    const t = Math.min(1, Math.max(0, v)) * (ramp.length - 1);
    const i = Math.min(ramp.length - 2, t | 0);
    const f = t - i;
    const a = ramp[i];
    const b = ramp[i + 1];
    return [
      a[0] + (b[0] - a[0]) * f,
      a[1] + (b[1] - a[1]) * f,
      a[2] + (b[2] - a[2]) * f,
    ];
  }

  /** Row y (device px, 0 = top) → band value, with optional bass stretch. */
  function bandAtRow(y: number, h: number, n: number, tilt: number): number {
    // 0 at the bottom (lowest frequency) … 1 at the top
    const up = 1 - y / h;
    const frac = tilt > 1.001 ? Math.pow(up, tilt) : up;
    const pos = frac * (n - 1);
    const i = Math.min(n - 2, Math.floor(pos));
    const f = pos - i;
    return (bands[i] ?? 0) * (1 - f) + (bands[i + 1] ?? 0) * f;
  }

  function drawSpectro(w: number, h: number, dpr: number) {
    const n = bands.length || 64;
    const step = Math.max(1, Math.round(params.get("spektro", "speed") * dpr));
    const contrast = params.get("spektro", "contrast");
    const floor = params.get("spektro", "floor");
    const tilt = params.get("spektro", "tilt");
    const palette = params.get("spektro", "palette") | 0;
    const barsOn = params.get("spektro", "bars") >= 0.5;

    const gridOn = params.get("spektro", "grid") >= 0.5;
    const barW = barsOn ? Math.min(w * 0.22, 240 * dpr) : 0;
    // the axis labels need a strip of their own — anything painted into the
    // scrolled region would be dragged along and smear
    const axisW = gridOn ? Math.round(Math.min(w * 0.08, 46 * dpr)) : 0;
    const wfW = Math.max(1, Math.round(w - barW));
    if (wfW - axisW <= step) return; // too narrow to scroll — nothing sensible to draw

    // shift the history left by one step, then paint the freed column
    ctx.drawImage(
      canvas,
      axisW + step, 0, wfW - axisW - step, h,
      axisW, 0, wfW - axisW - step, h,
    );

    // The fresh column is built as pixels rather than ~1000 fillRect calls —
    // same picture, a fraction of the per-frame cost.
    const colX = wfW - step;
    if (!spectroCol || spectroCol.width !== step || spectroCol.height !== h) {
      spectroCol = ctx.createImageData(step, h);
    }
    const px = spectroCol.data;
    const ramp = SPECTRO_RAMPS[palette] ?? SPECTRO_RAMPS[0];
    // Gridlines are blended into the column and then scroll along with the
    // data — drawing them across the history every frame would instead pile
    // alpha onto the same rows until they turned solid.
    const gridRows = gridOn ? spectroGridRows(h, tilt) : null;
    for (let y = 0; y < h; y++) {
      const raw = bandAtRow(y, h, n, tilt);
      const v = raw <= floor ? 0 : Math.min(1, (raw - floor) * contrast);
      let [r, g, b] = spectroRgb(v, ramp);
      if (gridRows?.has(y)) {
        r += (226 - r) * 0.22;
        g += (232 - g) * 0.22;
        b += (240 - b) * 0.22;
      }
      for (let dx = 0; dx < step; dx++) {
        const o = (y * step + dx) * 4;
        px[o] = r;
        px[o + 1] = g;
        px[o + 2] = b;
        px[o + 3] = 255;
      }
    }
    ctx.putImageData(spectroCol, colX, 0);

    // Time markers. With a locked grid these are musical — faint on beats,
    // brighter on the downbeat, brightest at the start of a phrase — so the
    // history reads like bars on a ruler. Without one, fall back to a plain
    // tick per detected onset.
    let markAlpha = 0;
    if (gridConf >= GRID_LOCKED) {
      const beatIdx = Math.floor(beatCount);
      if (beatIdx !== prevSpectroBeatIdx) {
        prevSpectroBeatIdx = beatIdx;
        const inPhrase = Math.round(phrasePhase * 32) % 32;
        const inBar = Math.round(barPhase * 4) % 4;
        markAlpha = inPhrase === 0 ? 0.55 : inBar === 0 ? 0.3 : 0.12;
      }
    } else if (beat > 0.6 && prevSpectroBeat <= 0.6) {
      markAlpha = 0.42;
    }
    if (markAlpha > 0) {
      ctx.fillStyle = `rgba(255, 255, 255, ${markAlpha})`;
      ctx.fillRect(colX, 0, Math.max(1, Math.round(step * 0.4)), h);
    }
    prevSpectroBeat = beat;

    if (gridOn) drawSpectroAxis(axisW, h, dpr, tilt);
    if (barsOn) drawSpectroBars(wfW, w, h, dpr, n, tilt, contrast, floor, palette);
  }

  const SPECTRO_MARKS = [100, 250, 500, 1000, 2000, 4000, 8000];

  /** Row of each labelled frequency — inverse of the band mapping. */
  function spectroRow(f: number, h: number, tilt: number): number {
    const F_MIN = 40;
    const F_MAX = 16000;
    const up = Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN);
    const frac = tilt > 1.001 ? Math.pow(up, 1 / tilt) : up;
    return Math.round((1 - frac) * h);
  }

  let gridRowCache = { h: 0, tilt: -1, rows: new Set<number>() };
  function spectroGridRows(h: number, tilt: number): Set<number> {
    if (gridRowCache.h !== h || gridRowCache.tilt !== tilt) {
      const rows = new Set<number>();
      for (const f of SPECTRO_MARKS) rows.add(spectroRow(f, h, tilt));
      gridRowCache = { h, tilt, rows };
    }
    return gridRowCache.rows;
  }

  /** Frequency scale in its own strip on the left, repainted every frame. */
  function drawSpectroAxis(axisW: number, h: number, dpr: number, tilt: number) {
    ctx.fillStyle = "#07070c";
    ctx.fillRect(0, 0, axisW, h);
    ctx.font = `${9 * dpr}px ui-monospace, Consolas, monospace`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";
    for (const f of SPECTRO_MARKS) {
      const y = spectroRow(f, h, tilt);
      ctx.fillStyle = "rgba(226, 232, 240, 0.3)";
      ctx.fillRect(axisW - 4 * dpr, y, 4 * dpr, 1);
      ctx.fillStyle = "rgba(226, 232, 240, 0.55)";
      ctx.fillText(
        f >= 1000 ? `${f / 1000}k` : String(f),
        axisW - 6 * dpr,
        y,
      );
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
  }

  /** Live spectrum as horizontal bars in the right-hand strip — the classic
   *  analyser feeding the waterfall. Fully repainted every frame. */
  const spectroPeaks = new Float32Array(4096);
  function drawSpectroBars(
    wfW: number,
    w: number,
    h: number,
    dpr: number,
    n: number,
    tilt: number,
    contrast: number,
    floor: number,
    palette: number,
  ) {
    const strip = w - wfW;
    const ramp = SPECTRO_RAMPS[palette] ?? SPECTRO_RAMPS[0];
    ctx.fillStyle = "#07070c";
    ctx.fillRect(wfW, 0, strip, h);

    // separator between history and live bars
    ctx.fillStyle = "rgba(148, 163, 184, 0.25)";
    ctx.fillRect(wfW, 0, Math.max(1, dpr), h);

    const rowH = Math.max(2 * dpr, h / 96);
    const rows = Math.floor(h / rowH);
    const gap = rowH > 4 * dpr ? Math.max(1, dpr) : 0;
    const maxLen = strip - 2 * dpr;

    for (let r = 0; r < rows; r++) {
      const y = r * rowH;
      const raw = bandAtRow(y + rowH * 0.5, h, n, tilt);
      const v = raw <= floor ? 0 : Math.min(1, (raw - floor) * contrast);

      // peak hold decays slowly, like the caps on the bars visualization
      spectroPeaks[r] = Math.max(v, (spectroPeaks[r] ?? 0) - 0.012);

      const len = v * maxLen;
      if (len >= 1) {
        // bars read at a glance, so they take the bright end of the ramp
        const [cr, cg, cb] = spectroRgb(0.45 + v * 0.55, ramp);
        ctx.fillStyle = `rgb(${cr | 0} ${cg | 0} ${cb | 0})`;
        // anchored at the right edge, growing toward the waterfall
        ctx.fillRect(w - len, y, len, rowH - gap);
      }
      const pk = spectroPeaks[r] * maxLen;
      if (pk >= 2) {
        ctx.fillStyle = "rgba(248, 250, 252, 0.7)";
        ctx.fillRect(w - pk, y, Math.max(1, dpr), rowH - gap);
      }
    }
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
