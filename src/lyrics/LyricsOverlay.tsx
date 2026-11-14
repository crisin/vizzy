import { useEffect, useReducer, useRef, type CSSProperties } from "react";
import { params } from "../params";
import { live } from "../milkdrop/live";
import { keyLabel } from "../keys";
import { lyrics, useLyrics } from "./store";
import "./lyrics.css";

const POSITIONS = ["bottom", "top", "middle", "bottom-left"] as const;
const ANIMS = ["none", "fade", "rise", "words"] as const;
const STYLES = ["shadow", "box", "outline", "glow"] as const;
const COLORS = ["#ffffff", "#ffe08a", "#7fe7ff", "#ff8fd0", "#ff7a7a"];
const FONTS = [
  'system-ui, "Segoe UI", "SF Pro Display", Roboto, sans-serif',
  'Georgia, "Times New Roman", serif',
  '"Bahnschrift Condensed", "Bahnschrift", "Arial Narrow", "Roboto Condensed", sans-serif',
  'ui-monospace, "Cascadia Mono", Consolas, monospace',
];

const p = (key: string) => params.get("lyrics", key);

/**
 * Live lyrics on the stage: the last few committed lines, the newest at the
 * bottom, and the tentative tail fainter behind it. Pure display — what it
 * shows comes from the worker; how it looks from the "lyrics" parameters.
 */
export function LyricsOverlay({ onOpenSettings }: { onOpenSettings: () => void }) {
  const s = useLyrics();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => params.subscribe(rerender), []);
  useEffect(() => lyrics.startDemo(), []);

  // hide after a while without new text — needs a timer, nothing else
  // re-renders when the time runs out
  const hideAfter = p("hideAfter") * 1000;
  const sinceText = performance.now() - s.lastTextAt;
  const stale = hideAfter > 0 && s.lastTextAt > 0 && sinceText > hideAfter;
  useEffect(() => {
    if (hideAfter <= 0 || s.lastTextAt === 0 || stale) return;
    const id = window.setTimeout(rerender, hideAfter - sinceText + 20);
    return () => window.clearTimeout(id);
  }, [hideAfter, s.lastTextAt, stale, sinceText]);

  // loudness pulse on the newest line, straight to a CSS variable
  const rootRef = useRef<HTMLDivElement>(null);
  const pulse = p("pulse");
  useEffect(() => {
    const el = rootRef.current;
    if (!el || pulse <= 0) {
      el?.style.setProperty("--lyr-pulse", "1");
      return;
    }
    let raf = 0;
    let v = 0;
    const tick = () => {
      const target = Math.min(1, live.rms * 5);
      v += (target - v) * (target > v ? 0.5 : 0.12);
      el.style.setProperty("--lyr-pulse", String(1 + v * pulse));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [pulse]);

  if (!s.cfg.enabled) return null;

  const position = POSITIONS[p("position")] ?? "bottom";
  const anim = ANIMS[p("anim")] ?? "fade";
  const style = STYLES[p("style")] ?? "shadow";
  const colorIdx = p("color");
  const showStats = p("stats") >= 0.5;
  const animMs = p("animMs");

  const shownLines = stale ? [] : s.lines.slice(-Math.max(1, Math.round(p("lines"))));
  const tentative = !stale && p("tentative") >= 0.5 ? s.tentative : "";
  const olderFade = p("olderFade");

  const css = {
    "--lyr-size": `${p("size")}vh`,
    "--lyr-color": COLORS[colorIdx] ?? "#fff",
    "--lyr-font": FONTS[p("font")] ?? "inherit",
    "--lyr-weight": String(p("weight")),
    "--lyr-width": `${p("width")}%`,
    "--lyr-margin": `${p("margin")}vh`,
    "--lyr-box": String(p("boxAlpha")),
    "--lyr-tent": String(p("tentativeAlpha")),
    "--lyr-anim": `${animMs}ms`,
  } as CSSProperties;

  const cls = [
    "lyrics-overlay",
    `lyr-pos-${position}`,
    `lyr-style-${style}`,
    `lyr-anim-${anim}`,
    colorIdx === 4 ? "lyr-rainbow" : "",
    p("upper") >= 0.5 ? "lyr-upper" : "",
  ].join(" ");

  return (
    <div ref={rootRef} className={cls} style={css} aria-live="polite" aria-label="Liedtext">
      <div className="lyr-block">
        {shownLines.map((l, i) => {
          const age = shownLines.length - 1 - i; // 0 = newest
          const newest = age === 0;
          return (
            <div
              key={l.n}
              className={`lyr-line ${newest ? "lyr-newest" : ""}`}
              style={{ opacity: Math.max(0.08, 1 - age * olderFade) }}
            >
              <span className="lyr-text">
                {anim === "words"
                  ? l.text.split(" ").map((w, k, all) => (
                      <span
                        key={k}
                        className="lyr-word"
                        style={{ animationDelay: `${(animMs * k) / Math.max(1, all.length)}ms` }}
                      >
                        {w}{" "}
                      </span>
                    ))
                  : l.text}
              </span>
            </div>
          );
        })}
        {tentative && (
          <div className="lyr-line lyr-tentative">
            <span className="lyr-text">{tentative}</span>
          </div>
        )}
      </div>
      {s.error && (
        <button type="button" className="lyr-hint" onClick={onOpenSettings}>
          Lyrics: {s.error} · Einstellungen öffnen
        </button>
      )}
      {showStats && (
        <div className="lyr-stats">
          {s.demo ? "Demo · " : ""}
          {s.behindS != null ? `+${s.behindS.toFixed(1)} s` : "—"}
          {s.behindAvg != null ? ` (Ø ${s.behindAvg.toFixed(1)} s)` : ""} · Whisper {s.inferMs} ms · Fenster{" "}
          {s.windowS.toFixed(1)} s · {keyLabel("lyrics")} aus
        </div>
      )}
    </div>
  );
}
