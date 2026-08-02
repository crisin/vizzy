import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

const HEADER = 4;
const ATTACK_TAU = 0.035; // s — fast rise
const RELEASE_TAU = 0.22; // s — slow fall
const PEAK_GRAVITY = 0.5; // units/s

function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    return startVisualizer(canvas);
  }, []);

  return <canvas ref={canvasRef} id="viz" />;
}

function startVisualizer(canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext("2d")!;
  const inTauri = "__TAURI_INTERNALS__" in window;

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

    // EQ bars
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

    // peak caps
    ctx.fillStyle = "rgba(248, 250, 252, 0.65)";
    const capH = Math.max(1.5, h * 0.003);
    for (let i = 0; i < n; i++) {
      if (peaks[i] * maxBar < 2) continue;
      const x = gap + i * (bw + gap);
      ctx.fillRect(x, h - peaks[i] * maxBar - capH, bw, capH);
    }

    // waveform
    const midY = h * 0.3;
    const amp = h * 0.15;
    ctx.beginPath();
    for (let j = 0; j < wave.length; j++) {
      const x = (j / (wave.length - 1)) * w;
      const y = midY + wave[j] * amp;
      if (j === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "rgba(148, 163, 184, 0.55)";
    ctx.lineWidth = Math.max(1, 1.25 * dpr);
    ctx.stroke();

    // HUD
    ctx.font = `${11 * dpr}px ui-monospace, Consolas, monospace`;
    ctx.fillStyle = "rgba(226, 232, 240, 0.7)";
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    const source = inTauri ? "system loopback" : "demo mode (browser)";
    ctx.fillText(`vizzy // ${source}`, 12 * dpr, 10 * dpr);
    ctx.textAlign = "right";
    ctx.fillText(
      `${fps.toFixed(0)} fps  rms ${rms.toFixed(3)}`,
      w - 12 * dpr,
      10 * dpr,
    );
    ctx.textAlign = "left";
  }

  raf = requestAnimationFrame(frame);

  return () => {
    running = false;
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", resize);
  };
}

export default App;
