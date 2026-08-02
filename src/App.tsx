import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";

const HEADER = 4;
const ATTACK_TAU = 0.035; // s — fast rise
const RELEASE_TAU = 0.22; // s — slow fall
const PEAK_GRAVITY = 0.5; // units/s
const HUD_HIDE_MS = 2500;

const inTauri = "__TAURI_INTERNALS__" in window;

type SourceInfo = {
  id: string;
  name: string;
  kind: "loopback" | "input";
  is_default: boolean;
};

type VizMode = "bars" | "radial" | "scope";
const VIZ_MODES: VizMode[] = ["bars", "radial", "scope"];

function splitOnce(v: string, sep: string): [string, string] {
  const i = v.indexOf(sep);
  return [v.slice(0, i), v.slice(i + 1)];
}

function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const modeRef = useRef<VizMode>("bars");
  const [mode, setMode] = useState<VizMode>("bars");
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [selected, setSelected] = useState("");
  const [hudVisible, setHudVisible] = useState(true);
  const hideTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    return startVisualizer(canvas, modeRef);
  }, []);

  useEffect(() => {
    if (!inTauri) return;
    invoke<SourceInfo[]>("list_sources")
      .then((list) => {
        setSources(list);
        const def = list.find((s) => s.kind === "loopback" && s.is_default);
        if (def) setSelected(`loopback|${def.id}`);
      })
      .catch(console.error);
  }, []);

  const selectSource = useCallback(async (value: string) => {
    setSelected(value);
    const [kind, id] = splitOnce(value, "|");
    try {
      await invoke("set_source", { spec: { kind, device_id: id } });
    } catch (e) {
      console.error("set_source failed", e);
    }
  }, []);

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
      } else if (e.key === "Escape" && inTauri) {
        void getCurrentWindow().setFullscreen(false);
      } else if (e.key >= "1" && e.key <= String(VIZ_MODES.length)) {
        setMode(VIZ_MODES[Number(e.key) - 1]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleFullscreen]);

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
      className={`stage ${hudVisible ? "" : "idle"}`}
      onMouseMove={pokeHud}
    >
      <canvas ref={canvasRef} id="viz" />
      <div className={`hud ${hudVisible ? "" : "hidden"}`}>
        <div className="hud-left">
          <span className="brand">VIZZY</span>
          {inTauri ? (
            <select
              className="src-select"
              value={selected}
              onChange={(e) => selectSource(e.target.value)}
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
            </select>
          ) : (
            <span className="demo-tag">Demo-Modus (Browser)</span>
          )}
        </div>
        <div className="hud-right">
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
            className="mode-btn"
            onClick={() => void toggleFullscreen()}
            title="Fullscreen (F)"
          >
            ⛶
          </button>
        </div>
      </div>
    </div>
  );
}

function startVisualizer(
  canvas: HTMLCanvasElement,
  modeRef: { current: VizMode },
): () => void {
  const ctx = canvas.getContext("2d")!;

  let running = true;
  let raf = 0;

  // latest backend data
  let bands = new Float32Array(64);
  let wave = new Float32Array(512);
  let rms = 0;

  // smoothed display state
  let disp = new Float32Array(bands.length);
  let peaks = new Float32Array(bands.length);

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
  }

  let gradient: CanvasGradient | null = null;
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
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
  let fps = 60;

  function frame(now: number) {
    if (!running) return;
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    if (dt > 0) fps = fps * 0.92 + (1 / dt) * 0.08;

    if (inTauri) fetchFrame();
    else mockFrame(now / 1000);

    const attack = 1 - Math.exp(-dt / ATTACK_TAU);
    const release = 1 - Math.exp(-dt / RELEASE_TAU);
    for (let i = 0; i < disp.length; i++) {
      const target = bands[i];
      disp[i] += (target - disp[i]) * (target > disp[i] ? attack : release);
      peaks[i] = Math.max(peaks[i] - PEAK_GRAVITY * dt, disp[i]);
    }

    draw();
    raf = requestAnimationFrame(frame);
  }

  function draw() {
    const w = canvas.width;
    const h = canvas.height;
    const dpr = window.devicePixelRatio || 1;

    // translucent clear → motion trails
    ctx.fillStyle = "rgba(7, 7, 12, 0.35)";
    ctx.fillRect(0, 0, w, h);

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
    const maxBar = h * 0.72;

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
    const R = base * 0.2 * (1 + rms * 0.9);
    const maxLen = base * 0.26;
    const lw = Math.max(2, (Math.PI * R) / n * 0.7);

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
    // wide soft glow pass, then bright core
    drawWaveLine(w, h * 0.5, h * 0.32, "rgba(56, 189, 248, 0.18)", 12 * dpr);
    drawWaveLine(w, h * 0.5, h * 0.32, "#7dd3fc", 2 * dpr);

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
    ctx.lineWidth = lineWidth ?? Math.max(1, 1.25 * (window.devicePixelRatio || 1));
    ctx.stroke();
  }

  raf = requestAnimationFrame(frame);

  return () => {
    running = false;
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", resize);
  };
}

export default App;
