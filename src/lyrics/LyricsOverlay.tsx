import { useEffect, useReducer, useRef, useState, type CSSProperties } from "react";
import { params } from "../params";
import { live } from "../milkdrop/live";
import { keyLabel } from "../keys";
import { lyrics, useLyrics, type LyricLine } from "./store";
import { synced, useSynced } from "./synced";
import "./lyrics.css";

const POSITIONS = ["bottom", "top", "middle", "bottom-left"] as const;
const PLACES = ["static", "random", "drift", "bar", "pitch"] as const;
const ANIMS = ["none", "fade", "rise", "words", "beat"] as const;
const STYLES = ["shadow", "box", "outline", "glow"] as const;
const BGS = ["none", "band", "darken", "frost"] as const;
const BLENDS = ["normal", "screen", "overlay", "difference", "color-dodge"] as const;
const COLORS = ["#ffffff", "#ffe08a", "#7fe7ff", "#ff8fd0", "#ff7a7a"];
const FONTS = [
  'system-ui, "Segoe UI", "SF Pro Display", Roboto, sans-serif',
  'Georgia, "Times New Roman", serif',
  '"Bahnschrift Condensed", "Bahnschrift", "Arial Narrow", "Roboto Condensed", sans-serif',
  'ui-monospace, "Cascadia Mono", Consolas, monospace',
];
const MAX_WAVES = 8;

const p = (key: string) => params.get("lyrics", key);
const pt = (key: string) => params.get("lyricsTent", key);
const TENT_POS = ["bottom", "top", "middle", "bottom-left", "bottom-right", "top-left"] as const;
const TENT_COLORS = ["", "#ffffff", "#ffe08a", "#7fe7ff", "#ff8fd0", "#a8b3c4"];

type Wave = { id: number; x: number; y: number };

/** 80 Hz … 1 kHz on a log scale → 0..1 */
const pitchNorm = (hz: number) => Math.min(1, Math.max(0, Math.log2(hz / 80) / Math.log2(1000 / 80)));

/**
 * Live lyrics on the stage: the last few committed lines, the newest at the
 * bottom, and the tentative tail fainter behind it. Pure display — what it
 * shows comes from the worker; how it looks and moves from the "lyrics"
 * parameters; the voice signal (live.voice, live.pitch) drives pulse,
 * waves and the pitch placement.
 */
export function LyricsOverlay({ onOpenSettings }: { onOpenSettings: () => void }) {
  const s = useLyrics();
  const sy = useSynced();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => params.subscribe(rerender), []);
  useEffect(() => lyrics.startDemo(), []);

  // synced lines (Lyrics Helper, on time) or what Whisper heard
  const useSync = synced.mode() !== "whisper" && sy.usable;
  const onlySynced = synced.mode() === "synced";
  const sourceLines: LyricLine[] = useSync
    ? sy.lines
        .slice(0, sy.index + 1)
        .slice(-12)
        .map((l, i, arr) => {
          const idx = sy.index - (arr.length - 1 - i);
          return { n: 1_000_000 + idx, text: l.text, at: idx === sy.index ? sy.indexAt : 0, repeat: sy.repeats[idx] };
        })
    : onlySynced
      ? []
      : s.lines;
  const newest = sourceLines[sourceLines.length - 1]?.n ?? 0;
  // synced: the last line stays up while it is sung, so "stale" follows the line
  const lastText = useSync ? sy.indexAt : s.lastTextAt;

  // hide after a while without new text — needs a timer, nothing else
  // re-renders when the time runs out
  const hideAfter = p("hideAfter") * 1000;
  const sinceText = performance.now() - lastText;
  const stale = hideAfter > 0 && lastText > 0 && sinceText > hideAfter;
  useEffect(() => {
    if (hideAfter <= 0 || lastText === 0 || stale) return;
    const id = window.setTimeout(rerender, hideAfter - sinceText + 20);
    return () => window.clearTimeout(id);
  }, [hideAfter, lastText, stale, sinceText]);

  const rootRef = useRef<HTMLDivElement>(null);
  const blockRef = useRef<HTMLDivElement>(null);
  const dispRef = useRef<SVGFEDisplacementMapElement>(null);
  const [waves, setWaves] = useState<Wave[]>([]);
  const waveId = useRef(0);

  const enabled = s.cfg.enabled;
  const place = PLACES[p("place")] ?? "static";
  const spread = p("spread");
  const pulse = p("pulse");
  const pulseSrc = p("pulseSrc");
  const wavesMode = p("waves");
  const waveMs = p("waveMs");
  const wobble = p("wobble");

  /** a ring from the centre of the text */
  const emitWave = useRef(() => {});
  emitWave.current = () => {
    const el = blockRef.current;
    if (!el || !el.childElementCount) return;
    const r = el.getBoundingClientRect();
    const w: Wave = { id: ++waveId.current, x: r.left + r.width / 2, y: r.top + r.height / 2 };
    setWaves((ws) => [...ws.slice(-(MAX_WAVES - 1)), w]);
    window.setTimeout(() => setWaves((ws) => ws.filter((x) => x.id !== w.id)), waveMs + 50);
  };

  // a new line: jump somewhere new, ring, nudge Milkdrop
  const target = useRef({ x: 0, y: 0 });
  const lastLine = useRef(newest);
  useEffect(() => {
    if (newest === lastLine.current) return;
    lastLine.current = newest;
    if (place === "random") target.current = randomSpot(spread);
    if (wavesMode === 1) emitWave.current();
    const kick = p("kick");
    if (kick > 0) live.kick = Math.max(live.kick, kick);
  }, [newest, place, spread, wavesMode]);

  // per frame: placement, pulse, wobble, beat/voice waves — straight to the
  // DOM, React only renders when the text changes
  useEffect(() => {
    if (!enabled) return;
    let raf = 0;
    let pv = 0;
    let pos = { x: 0, y: 0 };
    let lastBeat = live.beatCount;
    let lastVoice = 0;
    let lastWaveAt = 0;
    let pitchY = 0;
    const t0 = performance.now();
    const tick = () => {
      const now = performance.now();
      const t = (now - t0) / 1000;
      const block = blockRef.current;
      const root = rootRef.current;

      // placement, in % of the viewport around the centre
      if (place === "drift") {
        target.current = { x: spread * Math.sin(t * 0.13), y: spread * 0.7 * Math.sin(t * 0.21 + 1.3) };
      } else if (place === "bar" && live.beatCount !== lastBeat && Math.floor(live.beatCount) % 4 === 0) {
        target.current = randomSpot(spread);
      } else if (place === "pitch") {
        if (live.pitchConf > 0.4 && live.pitch > 0) pitchY = (0.5 - pitchNorm(live.pitch)) * 2 * spread;
        target.current = { x: 0, y: pitchY };
      } else if (place === "static") {
        target.current = { x: 0, y: 0 };
      }
      const k = place === "pitch" ? 0.08 : place === "drift" ? 1 : 0.12;
      pos = { x: pos.x + (target.current.x - pos.x) * k, y: pos.y + (target.current.y - pos.y) * k };
      if (block) block.style.translate = place === "static" ? "" : `${pos.x}vw ${pos.y}vh`;

      // pulse on the newest line
      if (root) {
        const src = pulseSrc === 1 ? live.voice : Math.min(1, live.rms * 5);
        pv += (src - pv) * (src > pv ? 0.5 : 0.12);
        root.style.setProperty("--lyr-pulse", String(1 + pv * pulse));
      }

      // wobble: displacement grows with the level
      if (dispRef.current) dispRef.current.setAttribute("scale", String(wobble * Math.min(1, live.rms * 6)));

      // waves on the beat or on the syllables
      if (wavesMode === 2 && live.beatCount !== lastBeat) emitWave.current();
      if (wavesMode === 3) {
        const rising = live.voice > 0.7 && lastVoice <= 0.7;
        if (rising && now - lastWaveAt > 220) {
          emitWave.current();
          lastWaveAt = now;
        }
      }
      lastVoice = live.voice;
      lastBeat = live.beatCount;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [enabled, place, spread, pulse, pulseSrc, wobble, wavesMode]);

  if (!enabled) return null;

  const position = place === "static" ? (POSITIONS[p("position")] ?? "bottom") : "middle";
  const anim = ANIMS[p("anim")] ?? "fade";
  const style = STYLES[p("style")] ?? "shadow";
  const bg = BGS[p("bg")] ?? "none";
  const colorIdx = p("color");
  const showStats = p("stats") >= 0.5;
  const animMs = p("animMs");

  const shownLines = stale ? [] : sourceLines.slice(-Math.max(1, Math.round(p("lines"))));
  // synced: the slot of the tentative text previews the next line
  const nextLine = useSync ? (sy.lines[sy.index + 1]?.text ?? "") : onlySynced ? "" : s.tentative;
  const tentative = !stale && pt("show") >= 0.5 ? nextLine : "";
  const detach = pt("detach") >= 0.5;
  const tentStyle = pt("style") === 0 ? style : STYLES[pt("style") - 1];
  const tentCss = {
    "--lyr-tent": String(pt("alpha")),
    "--lyr-tent-size": `${pt("size")}em`,
    "--lyr-tent-color": TENT_COLORS[pt("color")] || "var(--lyr-color)",
    "--lyr-tent-style": pt("italic") >= 0.5 ? "italic" : "normal",
  } as CSSProperties;
  const tentLine = tentative ? (
    <div className={`lyr-line lyr-tentative lyr-style-${tentStyle}`} style={detach ? undefined : tentCss}>
      <span className="lyr-text">{tentative}</span>
    </div>
  ) : null;
  const olderFade = p("olderFade");

  const css = {
    "--lyr-size": `${p("size")}vh`,
    "--lyr-color": COLORS[colorIdx] ?? "#fff",
    "--lyr-font": FONTS[p("font")] ?? FONTS[0],
    "--lyr-weight": String(p("weight")),
    "--lyr-width": `${p("width")}%`,
    "--lyr-margin": `${p("margin")}vh`,
    "--lyr-box": String(p("boxAlpha")),
    "--lyr-bga": String(p("bgAlpha")),
    "--lyr-anim": `${animMs}ms`,
    "--lyr-wave": `${p("waveSize")}vmin`,
    "--lyr-wave-ms": `${waveMs}ms`,
    mixBlendMode: BLENDS[p("blend")] ?? "normal",
  } as CSSProperties;

  const cls = [
    "lyrics-overlay",
    `lyr-pos-${position}`,
    `lyr-anim-${anim}`,
    `lyr-bg-${bg}`,
    colorIdx === 4 ? "lyr-rainbow" : "",
    p("upper") >= 0.5 ? "lyr-upper" : "",
    place !== "static" ? "lyr-moving" : "",
  ].join(" ");

  return (
    <div ref={rootRef} className={cls} style={css} aria-live="polite" aria-label="Liedtext">
      {wobble > 0 && (
        <svg className="lyr-defs" aria-hidden>
          <filter id="lyr-wobble">
            <feTurbulence type="fractalNoise" baseFrequency="0.012 0.045" numOctaves={2} seed={3}>
              <animate attributeName="seed" values="1;9;1" dur="4s" repeatCount="indefinite" />
            </feTurbulence>
            <feDisplacementMap ref={dispRef} in="SourceGraphic" scale="0" xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </svg>
      )}
      {waves.map((w) => (
        <div key={w.id} className="lyr-wave" style={{ left: w.x, top: w.y }} aria-hidden />
      ))}
      <div ref={blockRef} className="lyr-block" style={wobble > 0 ? { filter: "url(#lyr-wobble)" } : undefined}>
        {shownLines.map((l, i) => {
          const age = shownLines.length - 1 - i; // 0 = newest
          return (
            <div
              key={l.n}
              className={`lyr-line lyr-style-${style} ${age === 0 ? "lyr-newest" : ""}`}
              style={{ opacity: Math.max(0.08, 1 - age * olderFade) }}
            >
              <span className="lyr-text">
                {anim === "words" || anim === "beat"
                  ? l.text.split(" ").map((w, k, all) => (
                      <span
                        key={k}
                        className="lyr-word"
                        style={{ animationDelay: `${wordDelay(anim, k, all.length, animMs, l.at)}ms` }}
                      >
                        {w}{" "}
                      </span>
                    ))
                  : l.text}
              </span>
            </div>
          );
        })}
        {!detach && tentLine}
      </div>
      {detach && tentLine && (
        <div
          className={`lyr-tent-box lyr-tpos-${TENT_POS[pt("position")] ?? "bottom"}`}
          style={{ ...tentCss, "--lyr-tent-margin": `${pt("margin")}vh`, "--lyr-tent-width": `${pt("width")}%` } as CSSProperties}
        >
          {tentLine}
        </div>
      )}
      {s.error && (
        <button type="button" className="lyr-hint" onClick={onOpenSettings}>
          Lyrics: {s.error} · Einstellungen öffnen
        </button>
      )}
      {showStats && (
        <div className="lyr-stats">
          {s.demo ? "Demo · " : ""}
          {useSync
            ? `synchron (${sy.clock === "media" ? "Media-Position" : "Whisper-Uhr"}, Versatz ${(sy.offsetMs / 1000).toFixed(1)} s, ${sy.matched} Treffer) · `
            : ""}
          {s.behindS != null ? `+${s.behindS.toFixed(1)} s` : "—"}
          {s.behindAvg != null ? ` (Ø ${s.behindAvg.toFixed(1)} s)` : ""} · Whisper {s.inferMs} ms · Fenster{" "}
          {s.windowS.toFixed(1)} s · {keyLabel("lyrics")} aus
        </div>
      )}
    </div>
  );
}

/** When word `k` of a line appears. "beat": one word per eighth note,
 *  starting on the next eighth after the line arrived (`at`) — fixed at that
 *  moment, so re-renders do not restart the reveal. */
const beatStart = new Map<number, number>();
function wordDelay(anim: string, k: number, n: number, animMs: number, at: number): number {
  if (anim !== "beat" || live.bpm < 40) return (animMs * k) / Math.max(1, n);
  const eighth = 30_000 / live.bpm;
  let start = beatStart.get(at);
  if (start === undefined) {
    const into = (live.beatPhase * 2) % 1; // position within the current eighth
    start = (1 - into) * eighth;
    beatStart.set(at, start);
    if (beatStart.size > 50) beatStart.delete(beatStart.keys().next().value!);
  }
  // relative to when the element appeared (≈ `at`), like the CSS animation
  return start + k * eighth;
}

/** somewhere within ±spread % of the centre, not too close to the last */
function randomSpot(spread: number): { x: number; y: number } {
  return { x: (Math.random() * 2 - 1) * spread, y: (Math.random() * 2 - 1) * spread * 0.8 };
}
