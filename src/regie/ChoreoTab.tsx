// Regie › Songs: song choreographies.
//   Timeline   — energy curve + detected sections of the song, cue blocks on
//                top; click to add a cue, drag a block's edge to move it
//   Sections   — one row per detected section: which picture there
//   Aufnehmen  — the song plays, you switch pictures, every change is a cue
// Cue details: anchored at a time (snapped to the next beat / bar when it
// plays) or at the n-th section change.

import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { useAnalysis, type SongAnalysis } from "./analysis";
import { choreos, sectionAt, useChoreos, useRecording, type Anchor, type Choreo, type Cue, type Snap } from "./choreo";
import { positionNow, useNowPlaying, type Track } from "./nowPlaying";
import { PresetPicker, entryLabel } from "./PresetPicker";

type Props = {
  presetKeys: string[];
  label: (key: string) => string;
  currentKey: string;
  onPlay: (key: string) => void;
};

type SongRef = { key: string; keys: string[]; title: string; artist: string; durationMs: number };

function fmt(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
}

/** A stable pleasant hue per picture, so repeats read as repeats. */
function hue(ref: string): number {
  let h = 0;
  for (let i = 0; i < ref.length; i++) h = (h * 31 + ref.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function ChoreoTab({ presetKeys, label, currentKey, onPlay }: Props) {
  const list = useChoreos();
  const { track, history } = useNowPlaying();
  const rec = useRecording();

  // songs: the one playing, those with a choreo, the recent ones
  const songs = useMemo(() => {
    const m = new Map<string, SongRef>();
    if (track)
      m.set(track.baseKey, {
        key: track.baseKey,
        keys: [track.baseKey, track.key],
        title: track.title,
        artist: track.artist,
        durationMs: track.durationMs ?? 0,
      });
    for (const c of list) if (!m.has(c.key)) m.set(c.key, { ...c });
    for (const h of history) {
      const base = h.key.startsWith("smtc:") ? h.key : null;
      if (base && !m.has(base)) m.set(base, { key: base, keys: [base], title: h.title, artist: h.artist, durationMs: 0 });
    }
    return [...m.values()];
  }, [track, list, history]);

  const [sel, setSel] = useState<string | null>(track?.baseKey ?? songs[0]?.key ?? null);
  const song = songs.find((s) => s.key === sel) ?? null;
  const choreo = song ? list.find((c) => c.key === song.key) : undefined;
  const analysis = useAnalysis(song?.key ?? null);
  const isPlaying = !!track && song?.key === track.baseKey;

  return (
    <div className="regie-body pools">
      <div className="pool-side">
        <ul className="pool-list">
          {songs.map((s) => {
            const c = list.find((x) => x.key === s.key);
            return (
              <li key={s.key}>
                <button
                  type="button"
                  className={`pool-item ${s.key === sel ? "active" : ""}`}
                  onClick={() => setSel(s.key)}
                  title={`${s.artist} — ${s.title}`}
                >
                  <span className="song-item-name">
                    {track?.baseKey === s.key && <span className="np-status np-playing">▶ </span>}
                    {s.title}
                  </span>
                  <span className="regie-dim">{c ? `${c.cues.length}` : ""}</span>
                </button>
              </li>
            );
          })}
        </ul>
        {songs.length === 0 && <p className="regie-empty">Spiel einen Song ab – er erscheint hier.</p>}
      </div>

      {song ? (
        <SongEditor
          key={song.key}
          song={song}
          choreo={choreo}
          analysis={analysis}
          track={isPlaying ? track : null}
          recording={rec?.key === song.key}
          presetKeys={presetKeys}
          label={label}
          currentKey={currentKey}
          onPlay={onPlay}
        />
      ) : (
        <p className="regie-empty">Wähle links einen Song.</p>
      )}
    </div>
  );
}

function SongEditor({
  song,
  choreo,
  analysis,
  track,
  recording,
  presetKeys,
  label,
  currentKey,
  onPlay,
}: {
  song: SongRef;
  choreo: Choreo | undefined;
  analysis: SongAnalysis | null;
  track: Track | null;
  recording: boolean;
  presetKeys: string[];
  label: (k: string) => string;
  currentKey: string;
  onPlay: (k: string) => void;
}) {
  const [selCue, setSelCue] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const duration = choreo?.durationMs || analysis?.durationMs || track?.durationMs || song.durationMs || 0;
  const sections = analysis?.sections ?? [];
  const cues = choreo?.cues ?? [];
  const cue = cues.find((c) => c.id === selCue) ?? null;

  const ensure = () =>
    choreos.ensure({
      baseKey: song.key,
      key: song.keys.find((k) => !k.startsWith("smtc:")) ?? song.key,
      title: song.title,
      artist: song.artist,
      durationMs: duration,
    });

  const addCue = (t: number, ref = currentKey) => {
    const c = ensure();
    const cueNew = choreos.addCue(c.key, { t: Math.round(t), anchor: "time", snap: "bar", ref });
    setSelCue(cueNew.id);
  };

  return (
    <div className="pool-main">
      <div className="regie-inline">
        <div className="choreo-title">
          <b>{song.title}</b> <span className="regie-dim">{song.artist}</span>
          {duration > 0 && <span className="regie-dim"> · {fmt(duration).replace(/\.\d$/, "")}</span>}
        </div>
        <span className="cockpit-spacer" />
        {choreo && (
          <label className="regie-toggle">
            <input
              type="checkbox"
              checked={choreo.enabled}
              onChange={(e) => choreos.patch(choreo.key, { enabled: e.target.checked })}
            />
            aktiv
          </label>
        )}
        {track &&
          (recording ? (
            <button type="button" className="mode-btn rec-on" onClick={() => choreos.stopRecording()}>
              ■ Stopp
            </button>
          ) : (
            <button
              type="button"
              className="mode-btn"
              onClick={() => choreos.startRecording(track, positionNow(track) ?? 0, currentKey)}
              title="Ab jetzt: jeder Bildwechsel wird ein Cue (spätere Cues werden ersetzt)"
            >
              ● Aufnehmen ab hier
            </button>
          ))}
      </div>

      {recording && (
        <div className="rec-hint">
          ● Aufnahme läuft – wechsle Bilder (←/→, Library, Queue). Jeder Wechsel landet auf dem nächsten Beat.
        </div>
      )}

      {duration > 0 ? (
        <Timeline
          duration={duration}
          analysis={analysis}
          cues={cues}
          track={track}
          selected={selCue}
          label={label}
          onSelect={setSelCue}
          onAdd={(t) => addCue(t)}
          onMove={(id, t) => choreo && choreos.updateCue(choreo.key, id, { t: Math.round(t) })}
        />
      ) : (
        <p className="regie-empty">Die Songlänge ist noch unbekannt – spiel den Song kurz an.</p>
      )}
      {!analysis && (
        <p className="regie-dim">
          Noch keine Analyse: einmal ganz durchhören, dann zeichnet vizzy Energie und Sections mit.
        </p>
      )}

      {cue && choreo && (
        <CueEditor
          cue={cue}
          choreoKey={choreo.key}
          sections={sections}
          presetKeys={presetKeys}
          label={label}
          onPlay={onPlay}
          onDone={() => setSelCue(null)}
        />
      )}

      {sections.length > 0 && (
        <SectionList
          sections={sections}
          analysis={analysis!}
          cues={cues}
          presetKeys={presetKeys}
          label={label}
          onAssign={(t, ref, existing) => {
            const c = ensure();
            if (existing) choreos.updateCue(c.key, existing.id, { ref });
            else choreos.addCue(c.key, { t: Math.round(t), anchor: "time", snap: "bar", ref });
          }}
          onSelect={setSelCue}
        />
      )}

      {choreo && (
        <div className="regie-inline pool-danger">
          {confirmDel ? (
            <>
              <span className="sp-error">Choreo mit {choreo.cues.length} Cues löschen?</span>
              <button
                type="button"
                className="mode-btn danger"
                onClick={() => {
                  choreos.remove(choreo.key);
                  setConfirmDel(false);
                }}
              >
                Ja, löschen
              </button>
              <button type="button" className="mode-btn" onClick={() => setConfirmDel(false)}>
                Abbrechen
              </button>
            </>
          ) : (
            <button type="button" className="mode-btn" onClick={() => setConfirmDel(true)}>
              Choreo löschen …
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------- timeline

const W = 1000;
const H = 120;
const LANE = 34; // cue lane height at the bottom

function Timeline({
  duration,
  analysis,
  cues,
  track,
  selected,
  label,
  onSelect,
  onAdd,
  onMove,
}: {
  duration: number;
  analysis: SongAnalysis | null;
  cues: Cue[];
  track: Track | null;
  selected: string | null;
  label: (k: string) => string;
  onSelect: (id: string) => void;
  onAdd: (t: number) => void;
  onMove: (id: string, t: number) => void;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [drag, setDrag] = useState<{ id: string; t: number } | null>(null);
  const [, tick] = useState(0);

  // playhead
  useEffect(() => {
    if (!track || track.status !== "playing") return;
    const id = window.setInterval(() => tick((n) => n + 1), 250);
    return () => window.clearInterval(id);
  }, [track]);

  const x = (t: number) => (t / duration) * W;
  const tAt = (clientX: number) => {
    const r = svgRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(duration, ((clientX - r.left) / r.width) * duration));
  };

  const energyPath = useMemo(() => {
    const e = analysis?.energy ?? [];
    const max = Math.max(1e-4, ...e.map((v) => v ?? 0));
    const top = H - LANE - 4;
    let d = "";
    let open = false;
    e.forEach((v, i) => {
      if (v === null) {
        if (open) d += ` L${x((i) * 1000)},${top} Z`;
        open = false;
        return;
      }
      const px = x(i * 1000 + 500);
      const py = top - (v / max) * (top - 6);
      if (!open) {
        d += ` M${x(i * 1000)},${top} L${px},${py}`;
        open = true;
      } else d += ` L${px},${py}`;
    });
    if (open) d += ` L${x(e.length * 1000)},${top} Z`;
    return d;
    // x depends on duration only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis, duration]);

  const shown = cues.map((c) => (drag?.id === c.id ? { ...c, t: drag.t } : c)).sort((a, b) => a.t - b.t);
  const pos = track ? positionNow(track) : null;

  const onBgDown = (e: RPointerEvent<SVGRectElement>) => onAdd(tAt(e.clientX));

  const onCueDown = (e: RPointerEvent<SVGGElement>, c: Cue) => {
    e.stopPropagation();
    onSelect(c.id);
    const start = e.clientX;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - start) > 3) moved = true;
      if (moved) setDrag({ id: c.id, t: tAt(ev.clientX) });
    };
    const up = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      if (moved) onMove(c.id, tAt(ev.clientX));
      setDrag(null);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  return (
    <div className="timeline-wrap">
      <svg
        ref={svgRef}
        className="timeline"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Song-Timeline"
      >
        <rect className="tl-bg" x={0} y={0} width={W} height={H} onPointerDown={onBgDown} />
        {energyPath && <path className="tl-energy" d={energyPath} pointerEvents="none" />}
        {(analysis?.sections ?? []).map((s, i) => (
          <line key={i} className="tl-section" x1={x(s)} x2={x(s)} y1={0} y2={H - LANE} pointerEvents="none" />
        ))}
        {shown.map((c, i) => {
          const x0 = x(c.t);
          const x1 = x(shown[i + 1]?.t ?? duration);
          return (
            <g
              key={c.id}
              className={`tl-cue ${c.id === selected ? "sel" : ""}`}
              onPointerDown={(e) => onCueDown(e, c)}
              style={{ ["--h" as string]: hue(c.ref) }}
            >
              <rect x={x0} y={H - LANE} width={Math.max(2, x1 - x0)} height={LANE} />
              <rect className="tl-cue-edge" x={x0} y={H - LANE - 6} width={3} height={LANE + 6} />
            </g>
          );
        })}
        {pos !== null && <line className="tl-playhead" x1={x(pos)} x2={x(pos)} y1={0} y2={H} pointerEvents="none" />}
      </svg>
      {/* labels as HTML so they don't stretch with the svg */}
      <div className="tl-labels" aria-hidden>
        {shown.map((c, i) => {
          const l = (c.t / duration) * 100;
          const w = (((shown[i + 1]?.t ?? duration) - c.t) / duration) * 100;
          return (
            <span key={c.id} style={{ left: `${l}%`, width: `${w}%` }}>
              {c.anchor === "section" ? "§ " : ""}
              {entryLabel(c.ref, label)}
            </span>
          );
        })}
      </div>
      <div className="tl-scale regie-dim">
        <span>0:00</span>
        <span>{drag ? fmt(drag.t) : "Klick: Cue mit laufendem Bild · Kante ziehen: verschieben"}</span>
        <span>{fmt(duration).replace(/\.\d$/, "")}</span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- cue editor

function CueEditor({
  cue,
  choreoKey,
  sections,
  presetKeys,
  label,
  onPlay,
  onDone,
}: {
  cue: Cue;
  choreoKey: string;
  sections: number[];
  presetKeys: string[];
  label: (k: string) => string;
  onPlay: (k: string) => void;
  onDone: () => void;
}) {
  const up = (p: Partial<Cue>) => choreos.updateCue(choreoKey, cue.id, p);
  return (
    <div className="cue-editor">
      <span className="cockpit-label">Cue</span>
      <span className="cue-time">{fmt(cue.t)}</span>
      <button type="button" className="icon-btn" onClick={() => up({ t: Math.max(0, cue.t - 500) })} aria-label="0,5 s früher">
        −
      </button>
      <button type="button" className="icon-btn" onClick={() => up({ t: cue.t + 500 })} aria-label="0,5 s später">
        +
      </button>
      <select
        className="src-select"
        value={cue.anchor}
        onChange={(e) => {
          const anchor = e.target.value as Anchor;
          up(anchor === "section" ? { anchor, section: sectionAt(sections, cue.t) } : { anchor });
        }}
        aria-label="Anker"
      >
        <option value="time">an der Zeit</option>
        <option value="section" disabled={sections.length === 0}>
          an der Section {cue.anchor === "section" ? cue.section : sectionAt(sections, cue.t)}
        </option>
      </select>
      {cue.anchor === "time" && (
        <select
          className="src-select"
          value={cue.snap}
          onChange={(e) => up({ snap: e.target.value as Snap })}
          aria-label="Einrasten"
        >
          <option value="none">sofort</option>
          <option value="beat">nächster Beat</option>
          <option value="bar">nächster Takt</option>
        </select>
      )}
      <span className="rule-value">
        <PresetPicker
          presetKeys={presetKeys}
          label={label}
          withCombos
          placeholder="Bild wählen …"
          current={entryLabel(cue.ref, label)}
          onPick={(ref) => up({ ref })}
        />
      </span>
      <span className="rule-tools">
        {!cue.ref.startsWith("combo:") && (
          <button type="button" className="icon-btn" onClick={() => onPlay(cue.ref)} aria-label="Anspielen">
            ▶
          </button>
        )}
        <button
          type="button"
          className="icon-btn danger"
          onClick={() => {
            choreos.removeCue(choreoKey, cue.id);
            onDone();
          }}
          aria-label="Cue löschen"
        >
          ✕
        </button>
      </span>
    </div>
  );
}

// ------------------------------------------------------------- sections

function SectionList({
  sections,
  analysis,
  cues,
  presetKeys,
  label,
  onAssign,
  onSelect,
}: {
  sections: number[];
  analysis: SongAnalysis;
  cues: Cue[];
  presetKeys: string[];
  label: (k: string) => string;
  onAssign: (t: number, ref: string, existing: Cue | undefined) => void;
  onSelect: (id: string) => void;
}) {
  const starts = [0, ...sections];
  const max = Math.max(1e-4, ...analysis.energy.map((v) => v ?? 0));
  const level = (a: number, b: number) => {
    const vals = analysis.energy.slice(Math.floor(a / 1000), Math.ceil(b / 1000)).filter((v): v is number => v !== null);
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length / max : 0;
  };
  const bars = "▁▂▃▄▅▆▇█";
  return (
    <div className="section-list">
      <div className="cockpit-label">Sections ({starts.length})</div>
      <ol className="pool-entries">
        {starts.map((t, i) => {
          const end = starts[i + 1] ?? analysis.durationMs;
          const existing = cues.find((c) => Math.abs(c.t - t) < 1500);
          const lv = level(t, end);
          return (
            <li key={i}>
              <span className="rule-prio">{i}</span>
              <span className="cue-time">{fmt(t).replace(/\.\d$/, "")}</span>
              <span className="section-level" title={`Energie ${Math.round(lv * 100)} %`}>
                {bars[Math.min(7, Math.floor(lv * 8))]}
              </span>
              <span className="rule-value">
                <PresetPicker
                  presetKeys={presetKeys}
                  label={label}
                  withCombos
                  placeholder="Bild für diese Section …"
                  current={existing ? entryLabel(existing.ref, label) : undefined}
                  onPick={(ref) => onAssign(t, ref, existing)}
                />
              </span>
              {existing && (
                <button type="button" className="icon-btn" onClick={() => onSelect(existing.id)} aria-label="Cue bearbeiten">
                  ✎
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
