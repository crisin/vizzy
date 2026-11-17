// The switches of the lyrics config (lyrics.json) as named controls. The
// Lyrics tab places them in its sections; the "Aktuell" tab shows the same
// ones next to the news they belong to — one implementation per switch.

import type { ReactNode } from "react";
import { keyLabel } from "../keys";
import { useNewHelper } from "../regie/newHelper";
import { DEFAULT_CONFIG, PRESETS, lyrics, presetOf, useLyrics, type LyricsConfig } from "./store";

/** class for a row whose value is not the default ("nur Geändertes") */
function mark(cfg: LyricsConfig, key: keyof LyricsConfig): string {
  return cfg[key] !== DEFAULT_CONFIG[key] ? "changed" : "";
}

function Enabled() {
  const { cfg } = useLyrics();
  return (
    <label className={`set-row set-row-toggle ${mark(cfg, "enabled")}`}>
      <input type="checkbox" checked={cfg.enabled} onChange={(e) => lyrics.configure({ enabled: e.target.checked })} />
      <span className="set-label">
        Live-Lyrics ({keyLabel("lyrics")})
        <small className="set-hint">
          Ein lokaler Whisper-Server schreibt mit, was gerade gesungen wird — 1–3 s hinter der Musik.
        </small>
      </span>
    </label>
  );
}

function Profile() {
  const { cfg } = useLyrics();
  const preset = presetOf(cfg);
  return (
    <div className={`lyr-form ${preset === "balanced" ? "" : "changed"}`}>
      <span className="set-label">
        Profil
        <small className="set-hint">
          {PRESETS.find((p) => p.id === preset)?.does ?? "Eigene Einstellung — unter „Erkennung“ von Hand angepasst"}
        </small>
      </span>
      <div className="set-seg" role="radiogroup" aria-label="Profil der Erkennung">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={preset === p.id}
            className={`mode-btn ${preset === p.id ? "active" : ""}`}
            title={p.does}
            onClick={() => lyrics.applyPreset(p.id)}
          >
            {p.label}
          </button>
        ))}
        {preset === null && (
          <button type="button" className="mode-btn active" role="radio" aria-checked disabled>
            Eigene
          </button>
        )}
      </div>
    </div>
  );
}

function RecordAll() {
  const { cfg } = useLyrics();
  const on = cfg.log === 2 && cfg.logAudio;
  return (
    <>
      <label className={`set-row set-row-toggle ${on ? "changed" : ""}`}>
        <input type="checkbox" checked={on} onChange={(e) => lyrics.recordAll(e.target.checked)} />
        <span className="set-label">
          Alles mitschneiden (Debug)
          <small className="set-hint">
            Ein Schalter für Protokoll auf „Debug“ und das Audio dazu. Rund 120 MB pro Stunde Musik — nach der
            Fehlersuche wieder ausschalten.
          </small>
        </span>
      </label>
      {on && !cfg.enabled && <p className="set-note">Schreibt erst mit, wenn Live-Lyrics an ist.</p>}
    </>
  );
}

function Log() {
  const { cfg } = useLyrics();
  return (
    <label className={`set-row set-row-select ${mark(cfg, "log")}`}>
      <span className="set-label">
        Mitschreiben
        <small className="set-hint">
          JSON Lines in <code>lyrics-log/</code> im App-Datenordner, eine Datei pro Tag (UTC): Song (mit
          Spotify-ID), Zeile mit ihrer Zeit im Song, Verzögerung, Pausen, geänderte Regler.
        </small>
      </span>
      <select className="src-select" value={cfg.log} onChange={(e) => lyrics.configure({ log: Number(e.target.value) })}>
        <option value={0}>Aus</option>
        <option value={1}>Zeilen</option>
        <option value={2}>Debug (jeder Whisper-Lauf, Synchron-Uhr, Media-Position)</option>
      </select>
    </label>
  );
}

function LogAudio() {
  const { cfg } = useLyrics();
  return (
    <label className={`set-row set-row-toggle ${mark(cfg, "logAudio")}`}>
      <input type="checkbox" checked={cfg.logAudio} onChange={(e) => lyrics.configure({ logAudio: e.target.checked })} />
      <span className="set-label">
        Audio mitschneiden
        <small className="set-hint">
          Was Whisper gehört hat, eine WAV-Datei pro Song (16 kHz mono, ~1,9 MB pro Minute) — zum Anhören und um
          einen Song mit anderen Reglern offline nachzuspielen (<code>lyrics_offline</code>, README).
        </small>
      </span>
    </label>
  );
}

function Takes() {
  const { cfg } = useLyrics();
  return (
    <label className={`set-row set-row-toggle ${mark(cfg, "takes")}`}>
      <input type="checkbox" checked={cfg.takes} onChange={(e) => lyrics.configure({ takes: e.target.checked })} />
      <span className="set-label">
        Pro Song mitschreiben
        <small className="set-hint">
          Was gehört wurde, mit der Zeit im Song — eine Datei pro Song in <code>lyrics-takes/</code>. Als grober
          Entwurf für Lyrics Helper. Songs, von denen weniger als 40 % oder weniger als 5 Zeilen gehört wurden,
          werden nicht aufgehoben.
        </small>
      </span>
    </label>
  );
}

function TakesUpload() {
  const { cfg } = useLyrics();
  const nh = useNewHelper();
  const connected = !!nh.status.baseUrl && nh.status.hasToken;
  return (
    <label className={`set-row set-row-select ${mark(cfg, "takesUpload")}`}>
      <span className="set-label">
        An Lyrics Helper senden
        <small className="set-hint">
          {connected
            ? "Wenn ein Song vorbei ist. Dort liegt die Aufnahme neben dem Song; vorhandener Text wird nie überschrieben."
            : "Lyrics Helper ist nicht verbunden — im Cockpit unter „new-helper“ URL und Token eintragen."}
        </small>
      </span>
      <select
        className="src-select"
        value={cfg.takesUpload}
        disabled={!connected}
        onChange={(e) => lyrics.configure({ takesUpload: Number(e.target.value) })}
      >
        <option value={0}>Nur von Hand</option>
        <option value={1}>Automatisch, wenn dort synchroner Text fehlt</option>
        <option value={2}>Automatisch, immer</option>
      </select>
    </label>
  );
}

const CONTROLS = {
  enabled: Enabled,
  profile: Profile,
  recordAll: RecordAll,
  log: Log,
  logAudio: LogAudio,
  takes: Takes,
  takesUpload: TakesUpload,
} satisfies Record<string, () => ReactNode>;

export type LyricsControlId = keyof typeof CONTROLS;

export function hasLyricsControl(id: string): id is LyricsControlId {
  return id in CONTROLS;
}

export function LyricsControl({ id }: { id: LyricsControlId }) {
  const C = CONTROLS[id];
  return <C />;
}
