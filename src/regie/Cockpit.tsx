// Cockpit (key C): the side sheet that stays open next to the picture.
// What plays (song, playlist, position, source app), which rule is in
// charge, one-click binding of the current picture to song / artist /
// playlist or a pool, and the Spotify connection. The queue lands here next.

import { useEffect, useState } from "react";
import { appLabel, contextLabel, nowPlaying, positionNow, useNowPlaying, type MediaSession } from "./nowPlaying";
import { PictureSection } from "./PictureSection";
import { SpotifySection } from "./SpotifySection";
import { NewHelperSection, NhTagsLine } from "./NewHelperSection";
import "./regie.css";

const inTauri = "__TAURI_INTERNALS__" in window;

function fmt(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "–:––";
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function ago(at: number): string {
  const m = Math.round((Date.now() - at) / 60_000);
  if (m < 1) return "gerade";
  if (m < 60) return `vor ${m} min`;
  const h = Math.round(m / 60);
  return h < 24 ? `vor ${h} h` : `vor ${Math.round(h / 24)} d`;
}

const STATUS_ICON: Record<string, string> = { playing: "▶", paused: "⏸", stopped: "■", other: "·" };

type Props = {
  presetKey: string;
  presetLabel: string;
  autoSwitch: boolean;
  /** presets only exist in Milkdrop mode — binding needs it */
  canAssign: boolean;
  onClose: () => void;
  onOpenRegie: () => void;
};

export function Cockpit({ presetKey, presetLabel, autoSwitch, canAssign, onClose, onOpenRegie }: Props) {
  const { track, prefer, history } = useNowPlaying();
  const [sessions, setSessions] = useState<MediaSession[]>([]);
  const [, tick] = useState(0);

  // progress bar: re-render twice a second while something plays
  useEffect(() => {
    if (track?.status !== "playing") return;
    const id = window.setInterval(() => tick((n) => n + 1), 500);
    return () => window.clearInterval(id);
  }, [track?.status]);

  const refreshSessions = () => void nowPlaying.sessions().then(setSessions);
  useEffect(refreshSessions, []);

  const pos = positionNow(track);
  const dur = track?.durationMs ?? null;
  const pct = pos !== null && dur ? Math.min(100, (pos / dur) * 100) : 0;

  // the pinned app might not be running right now — keep it selectable
  const apps = new Map<string, string>();
  for (const s of sessions) apps.set(s.app, appLabel(s.app));
  if (prefer && ![...apps.keys()].some((a) => a.toLowerCase().includes(prefer.toLowerCase())))
    apps.set(prefer, `${prefer} (nicht aktiv)`);

  return (
    <aside className="cockpit" aria-label="Cockpit">
      <div className="cockpit-head">
        <span className="cockpit-title">Cockpit</span>
        <button type="button" className="mode-btn" onClick={onClose} title="Schließen (C)">
          ×
        </button>
      </div>

      <section className="cockpit-card" aria-live="polite">
        {track ? (
          <>
            <div className="np-title" title={track.title}>
              <span className={`np-status np-${track.status}`} aria-label={track.status}>
                {STATUS_ICON[track.status] ?? "·"}
              </span>
              {track.status === "other" ? "Werbung / Pause" : track.title}
            </div>
            <div className="np-artist" title={track.album}>
              {track.artist}
              {track.album && <span className="np-album"> · {track.album}</span>}
            </div>
            {track.context && (
              <div className="np-context" title={track.context.uri}>
                ▸ {contextLabel(track.context)}
              </div>
            )}
            <NhTagsLine />
            <div className="np-progress" aria-hidden>
              <div className="np-progress-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="np-meta">
              <span>
                {fmt(pos)} / {fmt(dur)}
              </span>
              <span className="np-app" title={track.key}>
                via {track.appLabel}
                {track.via === "both" && " + API"}
                {track.via === "spotify" && " (Web API)"}
              </span>
            </div>
          </>
        ) : (
          <div className="np-empty">
            {inTauri
              ? "Keine Wiedergabe erkannt. Spotify, Browser oder ein anderer Player mit Windows-Mediensteuerung wird automatisch erkannt."
              : "Browser-Vorschau: kein Zugriff auf die Mediensteuerung."}
          </div>
        )}
      </section>

      <PictureSection
        presetKey={presetKey}
        presetLabel={presetLabel}
        autoSwitch={autoSwitch}
        canAssign={canAssign}
        onOpenRegie={onOpenRegie}
      />

      <section className="cockpit-sec">
        <label className="cockpit-label" htmlFor="np-source">
          Song-Quelle
        </label>
        <div className="cockpit-row">
          <select
            id="np-source"
            className="src-select"
            value={prefer ?? ""}
            onChange={(e) => nowPlaying.setPrefer(e.target.value || null)}
            onFocus={refreshSessions}
          >
            <option value="">Automatisch (was gerade spielt)</option>
            {[...apps].map(([app, label]) => (
              <option key={app} value={app}>
                {label}
              </option>
            ))}
          </select>
          <button type="button" className="mode-btn" onClick={refreshSessions} title="Player neu suchen">
            ↻
          </button>
        </div>
      </section>

      <SpotifySection />
      <NewHelperSection />

      {history.length > 0 && (
        <section className="cockpit-sec cockpit-history">
          <div className="cockpit-label">Zuletzt</div>
          <ol>
            {history.slice(track ? 1 : 0, 9).map((h) => (
              <li key={h.key} title={`${h.artist} — ${h.title} (${h.app}${h.ctx ? ` · ${h.ctx}` : ""})`}>
                <span className="h-title">{h.title}</span>
                <span className="h-artist">{h.artist}</span>
                <span className="h-ago">{ago(h.at)}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </aside>
  );
}
