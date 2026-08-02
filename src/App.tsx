import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import butterchurn, { type BCVisualizer } from "butterchurn";
import butterchurnPresets from "butterchurn-presets";
import { SCENE_NAMES, Viz3D, type SceneName } from "./scenes3d";
import { params } from "./params";
import { EditorPanel } from "./EditorPanel";
import "./App.css";

const HEADER = 8; // [rms, peak, n_bands, n_wave, beat, flux, bpm, bpm_conf]
const PEAK_GRAVITY = 0.5; // units/s
const HUD_HIDE_MS = 2500;

const inTauri = "__TAURI_INTERNALS__" in window;

// UMD interop: depending on the bundler path the presets land on .default
const PRESETS: Record<string, unknown> =
  (butterchurnPresets as { default?: Record<string, unknown> }).default ??
  butterchurnPresets;
const PRESET_KEYS = Object.keys(PRESETS).sort((a, b) => a.localeCompare(b));

function flog(msg: string) {
  console.log(msg);
  if (inTauri) invoke("frontend_log", { msg }).catch(() => {});
}

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
  const [presetKey, setPresetKey] = useState(
    saved.presetKey && PRESET_KEYS.includes(saved.presetKey)
      ? saved.presetKey
      : (PRESET_KEYS[0] ?? ""),
  );
  const [autoSwitch, setAutoSwitch] = useState(saved.autoSwitch ?? false);
  const [showBpm, setShowBpm] = useState(saved.showBpm ?? false);
  const [editorOpen, setEditorOpen] = useState(false);
  const bpmElRef = useRef<HTMLSpanElement | null>(null);
  const [scene3d, setScene3d] = useState<SceneName>(
    saved.scene3d && SCENE_NAMES.includes(saved.scene3d)
      ? saved.scene3d
      : "orb",
  );
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [selected, setSelected] = useState("");
  const [hudVisible, setHudVisible] = useState(true);
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
    };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
    } catch {
      // storage unavailable — not worth breaking the app over
    }
  }, [mode, scene3d, presetKey, autoSwitch, showBpm, selected]);

  const stepPreset = useCallback((dir: number) => {
    setPresetKey((current) => {
      const i = PRESET_KEYS.indexOf(current);
      return PRESET_KEYS[(i + dir + PRESET_KEYS.length) % PRESET_KEYS.length];
    });
  }, []);

  const randomPreset = useCallback(() => {
    setPresetKey(PRESET_KEYS[Math.floor(Math.random() * PRESET_KEYS.length)]);
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "f" || e.key === "F11") {
        e.preventDefault();
        void toggleFullscreen();
      } else if (e.key === "e") {
        setEditorOpen((v) => !v);
      } else if (e.key === "b") {
        setShowBpm((v) => !v);
      } else if (e.key === "Escape" && inTauri) {
        void getCurrentWindow().setFullscreen(false);
      } else if (e.key >= "1" && e.key <= String(VIZ_MODES.length)) {
        setMode(VIZ_MODES[Number(e.key) - 1]);
      } else if (modeRef.current === "milkdrop") {
        if (e.key === "ArrowRight") stepPreset(1);
        else if (e.key === "ArrowLeft") stepPreset(-1);
        else if (e.key === "r") randomPreset();
        else if (e.key === "a") setAutoSwitch((v) => !v);
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
  }, [toggleFullscreen, stepPreset, randomPreset]);

  const pokeHud = useCallback(() => {
    setHudVisible(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(
      () => setHudVisible(false),
      HUD_HIDE_MS,
    );
  }, []);

  useEffect(() => {
    pokeHud();
    return () => window.clearTimeout(hideTimer.current);
  }, [pokeHud]);

  const loopbacks = sources.filter((s) => s.kind === "loopback");
  const inputs = sources.filter((s) => s.kind === "input");

  return (
    <div
      className={`stage mode-${mode} ${hudVisible ? "" : "idle"}`}
      onMouseMove={pokeHud}
    >
      <canvas ref={mdCanvasRef} id="mdviz" />
      <canvas ref={gl3dCanvasRef} id="viz3d" />
      <canvas ref={canvasRef} id="viz" />
      <div className={`hud ${hudVisible ? "" : "hidden"}`}>
        <div className="hud-row">
          <span className="brand">VIZZY</span>
          {inTauri ? (
            <select
              className="src-select"
              value={selected}
              onChange={(e) => selectSource(e.target.value)}
              onPointerDown={loadLists}
              title="Audio-Quelle"
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
              className={`mode-btn ${mode === m ? "active" : ""}`}
              onClick={() => setMode(m)}
              title={`Taste ${i + 1}`}
            >
              {m}
            </button>
          ))}
          <button
            className={`mode-btn ${showBpm ? "active" : ""}`}
            onClick={() => setShowBpm((v) => !v)}
            title="BPM-Anzeige (B)"
          >
            bpm
          </button>
          <button
            className={`mode-btn ${editorOpen ? "active" : ""}`}
            onClick={() => setEditorOpen((v) => !v)}
            title="Parameter-Editor (E)"
          >
            ⚙
          </button>
          <button
            className="mode-btn"
            onClick={() => void toggleFullscreen()}
            title="Fullscreen (F)"
          >
            ⛶
          </button>
        </div>
        {mode === "milkdrop" && (
          <div className="hud-row hud-sub">
            <button
              className="mode-btn"
              onClick={() => stepPreset(-1)}
              title="Vorheriges Preset (←)"
            >
              ‹
            </button>
            <select
              className="src-select preset-select"
              value={presetKey}
              onChange={(e) => setPresetKey(e.target.value)}
              title="Milkdrop-Preset"
            >
              {PRESET_KEYS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <button
              className="mode-btn"
              onClick={() => stepPreset(1)}
              title="Nächstes Preset (→)"
            >
              ›
            </button>
            <button
              className="mode-btn"
              onClick={randomPreset}
              title="Zufälliges Preset (R)"
            >
              🎲
            </button>
            <button
              className={`mode-btn ${autoSwitch ? "active" : ""}`}
              onClick={() => setAutoSwitch((v) => !v)}
              title="Auto-Wechsel bei Beats (A)"
            >
              auto
            </button>
          </div>
        )}
        {mode === "3d" && (
          <div className="hud-row hud-sub">
            {SCENE_NAMES.map((s) => (
              <button
                key={s}
                className={`mode-btn ${scene3d === s ? "active" : ""}`}
                onClick={() => setScene3d(s)}
                title="Szene (←/→)"
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>
      {editorOpen && (
        <EditorPanel
          groups={["audio", mode === "3d" ? scene3d : mode]}
          onClose={() => setEditorOpen(false)}
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
): () => void {
  const ctx = canvas.getContext("2d")!;

  let running = true;
  let raf = 0;

  // latest backend data
  let bands = new Float32Array(64);
  let wave = new Float32Array(1024);
  let rms = 0;
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
  let viz3dFailed = false;

  function ensure3D(): boolean {
    if (viz3d) return true;
    if (viz3dFailed) return false;
    if (gl3dCanvas.clientWidth === 0 || gl3dCanvas.clientHeight === 0) {
      return false;
    }
    try {
      viz3d = new Viz3D(gl3dCanvas, sceneRef.current);
      flog(`[3d] renderer init ok, ${gl3dCanvas.width}x${gl3dCanvas.height}`);
      return true;
    } catch (e) {
      viz3dFailed = true;
      flog(`[3d] renderer init FAILED: ${e}`);
      return false;
    }
  }

  function render3D(dt: number, t: number) {
    if (!ensure3D() || !viz3d) return;
    try {
      viz3d.setScene(sceneRef.current);
      viz3d.render({ disp, wave, rms, beat, dt, t });
    } catch (e) {
      viz3dFailed = true;
      flog(`[3d] render FAILED: ${e}`);
    }
  }

  // butterchurn state (lazy)
  let bc: BCVisualizer | null = null;
  let bcFailed = false;
  let bcLoadedPreset = "";
  const timeByte = new Uint8Array(1024).fill(128);

  function ensureButterchurn(): boolean {
    if (bc) return true;
    if (bcFailed) return false;
    if (mdCanvas.clientWidth === 0 || mdCanvas.clientHeight === 0) {
      return false; // layout not ready yet — retry next frame
    }
    try {
      const audioCtx = new AudioContext();
      bc = butterchurn.createVisualizer(audioCtx, mdCanvas, {
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
      flog(`[md] butterchurn init FAILED: ${e}`);
      return false;
    }
  }

  function renderMilkdrop() {
    if (!ensureButterchurn() || !bc) return;

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
    if (want !== bcLoadedPreset && PRESETS[want]) {
      try {
        bc.loadPreset(
          PRESETS[want],
          bcLoadedPreset ? params.get("milkdrop", "blend") : 0,
        );
        bcLoadedPreset = want;
        flog(`[md] preset: ${want}`);
      } catch (e) {
        flog(`[md] loadPreset FAILED (${want}): ${e}`);
        bcLoadedPreset = want; // don't retry a broken preset every frame
      }
    }

    const n = Math.min(wave.length, timeByte.length);
    for (let j = 0; j < n; j++) {
      const v = Math.max(-1, Math.min(1, wave[j]));
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
  async function fetchFrame() {
    if (fetching) return;
    fetching = true;
    try {
      const buf = await invoke<ArrayBuffer>("get_analysis_frame");
      const f = new Float32Array(buf);
      const nBands = f[2] | 0;
      const nWave = f[3] | 0;
      rms = f[0];
      beat = f[4];
      bpm = f[6];
      bpmConf = f[7];
      bands = f.subarray(HEADER, HEADER + nBands);
      wave = f.subarray(HEADER + nBands, HEADER + nBands + nWave);
      if (disp.length !== nBands) {
        disp = new Float32Array(nBands);
        peaks = new Float32Array(nBands);
      }
    } catch {
      // single missed frame is fine
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
    beat = Math.pow(0.5 + 0.5 * Math.sin(t * 4.2), 12);
    bpm = 128;
    bpmConf = 0.9;
  }

  let gradient: CanvasGradient | null = null;
  function resize() {
    const dpr = window.devicePixelRatio || 1;
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

  // Eager init so a broken WebGL/butterchurn/three setup surfaces in the
  // dev log immediately instead of on the first mode switch.
  ensureButterchurn();
  ensure3D();

  let last = performance.now();
  let fps = 60;

  function frame(now: number) {
    if (!running) return;
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    if (dt > 0) fps = fps * 0.92 + (1 / dt) * 0.08;

    // Layout/dpr can change without a window resize event (e.g. CSS landing
    // after init) — cheap per-frame check keeps bitmap sizes in sync.
    const dprNow = window.devicePixelRatio || 1;
    if (
      canvas.width !== Math.round(canvas.clientWidth * dprNow) ||
      canvas.height !== Math.round(canvas.clientHeight * dprNow)
    ) {
      resize();
    }

    if (inTauri) fetchFrame();
    else mockFrame(now / 1000);

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
      draw();
    }

    const el = bpmEl.current;
    if (el) {
      const text =
        bpmConf > 0.3 && bpm > 40 ? `${Math.round(bpm)} BPM` : "· · ·";
      if (el.textContent !== text) el.textContent = text;
      el.style.transform = `scale(${(1 + beat * 0.15).toFixed(3)})`;
    }

    raf = requestAnimationFrame(frame);
  }

  function draw() {
    const w = canvas.width;
    const h = canvas.height;
    const dpr = window.devicePixelRatio || 1;

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
    ctx.lineWidth =
      lineWidth ?? Math.max(1, 1.25 * (window.devicePixelRatio || 1));
    ctx.stroke();
  }

  raf = requestAnimationFrame(frame);

  return () => {
    running = false;
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", resize);
    viz3d?.dispose();
  };
}

export default App;
