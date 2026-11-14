// The "Lyrics" tab of the settings drawer: on/off and status, the Whisper
// server, how the text looks (the "lyrics" parameter group) and the engine's
// knobs (lyrics.json, applied live by the worker).

import { useEffect, useReducer, useState } from "react";
import { ParamRow, Section } from "../ui/ParamRow";
import { ParamGroup } from "../ui/ParamGroup";
import { keyLabel } from "../keys";
import { DEFAULT_CONFIG, PRESETS, lyrics, presetOf, useLyrics, type LyricsConfig } from "./store";
import { useSynced } from "./synced";

const LANGUAGES: [string, string][] = [
  ["auto", "Automatisch erkennen"],
  ["de", "Deutsch"],
  ["en", "Englisch"],
  ["es", "Spanisch"],
  ["fr", "Französisch"],
  ["it", "Italienisch"],
  ["pt", "Portugiesisch"],
  ["nl", "Niederländisch"],
  ["tr", "Türkisch"],
  ["pl", "Polnisch"],
  ["ru", "Russisch"],
  ["ja", "Japanisch"],
  ["ko", "Koreanisch"],
];

type Knob = {
  key: keyof LyricsConfig;
  label: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
  hint?: string;
};

const KNOBS: Knob[] = [
  { key: "stepMs", label: "Takt", min: 100, max: 3000, step: 50, unit: "ms",
    hint: "Wie oft das Fenster an Whisper geht. Kürzer = schneller, mehr GPU" },
  { key: "minWindow", label: "Mindestfenster", min: 0.5, max: 6, step: 0.1, unit: "s",
    hint: "Erst ab so viel Audio wird gefragt" },
  { key: "maxWindow", label: "Längstes Fenster", min: 3, max: 30, step: 0.5, unit: "s",
    hint: "Ohne Einigung bis hierhin wird die erste Zeile erzwungen" },
  { key: "edge", label: "Rand-Sperre", min: 0, max: 3, step: 0.05, unit: "s",
    hint: "Text, der so nah am Fensterende endet, wird nie fest (abgeschnittene Wörter)" },
  { key: "similarity", label: "Einigkeit", min: 0.3, max: 1, step: 0.01,
    hint: "Anteil gleicher Wörter, damit zwei Durchläufe als „einig“ gelten" },
  { key: "silenceDb", label: "Stille-Schwelle", min: -90, max: -10, step: 1, unit: "dB",
    hint: "Leiser als das ⇒ Pause: alles Vorläufige wird fest, Fenster leer" },
  { key: "silenceSecs", label: "Stille-Dauer", min: 0.3, max: 10, step: 0.1, unit: "s" },
  { key: "minAvgLogprob", label: "Mindest-Sicherheit", min: -5, max: 0, step: 0.05,
    hint: "Whispers avg_logprob — Segmente darunter fliegen raus. Näher an 0 = strenger" },
  { key: "maxReps", label: "Wiederholungen", min: 1, max: 20, step: 1,
    hint: "Eine Phrase öfter hintereinander wird abgeschnitten (Whisper hängt in Schleifen)" },
];

export function LyricsSettings() {
  const s = useLyrics();
  const cfg = s.cfg;
  const [url, setUrl] = useState(cfg.url);
  const [test, setTest] = useState<{ busy: boolean; msg: string; ok: boolean } | null>(null);
  const [, tick] = useState(0);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => setUrl(cfg.url), [cfg.url]);
  // the status line ages ("seit 3 s still") without events
  useEffect(() => {
    if (!cfg.enabled) return;
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [cfg.enabled]);

  const preset = presetOf(cfg);
  const changedKnobs = KNOBS.filter((k) => cfg[k.key] !== DEFAULT_CONFIG[k.key]).length +
    (cfg.filterInventions !== DEFAULT_CONFIG.filterInventions ? 1 : 0) +
    (cfg.dropUnconfirmed !== DEFAULT_CONFIG.dropUnconfirmed ? 1 : 0) +
    (cfg.prompt !== "" ? 1 : 0);

  const runTest = () => {
    setTest({ busy: true, msg: "Prüfe …", ok: false });
    lyrics
      .test(url.trim())
      .then((ms) => setTest({ busy: false, msg: `✓ erreichbar, Antwort in ${ms} ms`, ok: true }))
      .catch((e) => setTest({ busy: false, msg: String(e), ok: false }));
  };

  return (
    <div className="lyr-settings">
      <label className="set-row set-row-toggle">
        <input
          type="checkbox"
          checked={cfg.enabled}
          onChange={(e) => lyrics.configure({ enabled: e.target.checked })}
        />
        <span className="set-label">
          Live-Lyrics ({keyLabel("lyrics")})
          <small className="set-hint">
            Ein lokaler Whisper-Server schreibt mit, was gerade gesungen wird — 1–3 s hinter der Musik.
          </small>
        </span>
      </label>

      <Status />
      <SyncStatus />

      <div className="set-seg">
        <button type="button" className="mode-btn" onClick={() => lyrics.reset()} disabled={!cfg.enabled}>
          Neu anfangen
        </button>
      </div>

      <div className="lyr-form">
        <span className="set-label">
          Profil
          <small className="set-hint">
            {PRESETS.find((p) => p.id === preset)?.does ??
              "Eigene Einstellung — unter „Erkennung“ von Hand angepasst"}
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

      <Section id="lyrics.server" title="Whisper-Server">
        <form
          className="lyr-form"
          onSubmit={(e) => {
            e.preventDefault();
            lyrics.configure({ url: url.trim() });
            runTest();
          }}
        >
          <span className="set-label">Adresse</span>
          <div className="lyr-row">
            <input
              className="lyr-input"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onBlur={() => url.trim() !== cfg.url && lyrics.configure({ url: url.trim() })}
              spellCheck={false}
              aria-label="Adresse des Whisper-Servers"
            />
            <button type="submit" className="mode-btn" disabled={test?.busy}>
              Testen
            </button>
          </div>
          {test && <span className={`lyr-test ${test.ok ? "ok" : test.busy ? "" : "bad"}`}>{test.msg}</span>}
          <small className="set-hint">
            whisper.cpp-Server (<code>/inference</code>) oder OpenAI-kompatibel (Adresse endet auf{" "}
            <code>/v1</code>). Starten: <code>docker compose up -d</code> in <code>tools/whisper-server</code>.
          </small>
        </form>

        <label className="set-row set-row-select">
          <span className="set-label">Sprache</span>
          <select
            className="src-select"
            value={LANGUAGES.some(([v]) => v === cfg.language) ? cfg.language : "auto"}
            onChange={(e) => lyrics.configure({ language: e.target.value })}
          >
            {LANGUAGES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>

        {cfg.url.trim().replace(/\/$/, "").endsWith("/v1") && (
          <label className="lyr-form">
            <span className="set-label">Modell</span>
            <input
              className="lyr-input"
              value={cfg.model}
              placeholder="whisper-1"
              onChange={(e) => lyrics.configure({ model: e.target.value })}
              spellCheck={false}
            />
          </label>
        )}

        <label className="lyr-form">
          <span className="set-label">
            Prompt
            <small className="set-hint">
              Optionaler Kontext für Whisper: Songtitel, Künstler, ein paar Zeilen Text. Hilft bei Namen und
              Schreibweisen, kann aber auch Erfundenes anstoßen.
            </small>
          </span>
          <textarea
            className="lyr-input lyr-prompt"
            rows={2}
            value={cfg.prompt}
            onChange={(e) => lyrics.configure({ prompt: e.target.value })}
            spellCheck={false}
          />
        </label>
      </Section>

      <ParamGroup group="lyrics" onChanged={bump} />
      <ParamGroup group="lyricsTent" onChanged={bump} />

      <Section id="lyrics.log" title="Protokoll" badge={cfg.log ? (cfg.log === 2 ? "Debug" : "an") : undefined}>
        <label className="set-row set-row-select">
          <span className="set-label">
            Mitschreiben
            <small className="set-hint">
              JSON Lines in <code>lyrics-log/</code> im App-Datenordner, eine Datei pro Tag (UTC): Song,
              Zeile, Verzögerung, Pausen, geänderte Regler.
            </small>
          </span>
          <select
            className="src-select"
            value={cfg.log}
            onChange={(e) => lyrics.configure({ log: Number(e.target.value) })}
          >
            <option value={0}>Aus</option>
            <option value={1}>Zeilen</option>
            <option value={2}>Debug (jeder Whisper-Lauf, roh und gefiltert)</option>
          </select>
        </label>
        <label className="set-row set-row-toggle">
          <input
            type="checkbox"
            checked={cfg.logAudio}
            onChange={(e) => lyrics.configure({ logAudio: e.target.checked })}
          />
          <span className="set-label">
            Audio mitschneiden
            <small className="set-hint">
              Was Whisper gehört hat, eine Datei pro Song (16 kHz mono f32, ~3,8 MB pro Minute). Damit lässt
              sich ein Song mit anderen Reglern offline nachspielen (<code>lyrics_offline</code>, README).
            </small>
          </span>
        </label>
        <div className="set-seg">
          <button type="button" className="mode-btn" onClick={() => lyrics.openLog()} disabled={s.demo}>
            Ordner öffnen
          </button>
        </div>
      </Section>

      <Section
        id="lyrics.engine"
        title="Erkennung"
        badge={changedKnobs ? `${changedKnobs} geändert` : undefined}
        resetDisabled={changedKnobs === 0}
        onReset={() => lyrics.resetTuning()}
      >
        <p className="set-note">
          Whisper hört ein gleitendes Fenster immer wieder. Eine Zeile wird fest, wenn zwei Durchläufe sich einig
          sind. Änderungen wirken beim nächsten Takt — „Neu anfangen“ zeigt sie von vorn.
        </p>
        {KNOBS.map((k) => (
          <ParamRow
            key={k.key}
            label={k.label}
            hint={k.hint}
            value={cfg[k.key] as number}
            min={k.min}
            max={k.max}
            step={k.step}
            unit={k.unit}
            defaultValue={DEFAULT_CONFIG[k.key] as number}
            onChange={(v) => lyrics.configure({ [k.key]: v })}
            onReset={() => lyrics.configure({ [k.key]: DEFAULT_CONFIG[k.key] })}
          />
        ))}
        <label className="set-row set-row-toggle">
          <input
            type="checkbox"
            checked={cfg.filterInventions}
            onChange={(e) => lyrics.configure({ filterInventions: e.target.checked })}
          />
          <span className="set-label">
            Erfundenes filtern
            <small className="set-hint">
              [Music], „Thank you.“, „Музыка“ und Ähnliches, was Whisper über Instrumentals hört
            </small>
          </span>
        </label>
        <label className="set-row set-row-toggle">
          <input
            type="checkbox"
            checked={cfg.dropUnconfirmed}
            onChange={(e) => lyrics.configure({ dropUnconfirmed: e.target.checked })}
          />
          <span className="set-label">
            Unbestätigtes verwerfen
            <small className="set-hint">
              Volles Fenster ohne Einigung: die erste Zeile nur behalten, wenn der Durchlauf davor sie auch gehört
              hat. Aus = immer behalten (mehr Text, mehr Unsinn)
            </small>
          </span>
        </label>
      </Section>
    </div>
  );
}

/** Whether synced lines from Lyrics Helper are in play for this song. */
function SyncStatus() {
  const sy = useSynced();
  if (!sy.song) return null;
  if (!sy.available)
    return (
      <p className="set-note">
        Synchron: Lyrics Helper hat für diesen Song keinen Text mit Zeiten — es zeigt, was Whisper hört.
      </p>
    );
  const clock =
    sy.clock === "media"
      ? `Uhr: Media-Position${sy.matched ? `, von Whisper nachgestellt (${sy.matched}×, Versatz ${(sy.offsetMs / 1000).toFixed(1)} s)` : ""}`
      : sy.clock === "whisper"
        ? "Uhr: Whisper (keine Media-Position)"
        : "wartet auf eine erkannte Zeile";
  return (
    <p className="set-note lyr-status">
      <span className="lyr-dot" aria-hidden /> Synchron: {sy.lines.length} Zeilen aus Lyrics Helper · {clock}
    </p>
  );
}

/** One line: what the worker is doing right now. */
function Status() {
  const s = useLyrics();
  if (!s.cfg.enabled) return <p className="set-note">Aus.</p>;
  if (s.error) return <p className="lyr-test bad">{s.error}</p>;
  const quiet = s.lastEventAt ? (performance.now() - s.lastEventAt) / 1000 : Infinity;
  const head = s.demo
    ? "Demo im Browser (erfundener Text)"
    : quiet > 5
      ? "Läuft · wartet auf Musik"
      : s.windowS > 0
        ? "Läuft · hört zu"
        : "Läuft · Pause erkannt";
  const nums = [
    s.behindAvg != null ? `Ø ${s.behindAvg.toFixed(1)} s hinter der Musik` : "",
    s.inferMs ? `Whisper ${s.inferMs} ms` : "",
    s.windowS > 0 ? `Fenster ${s.windowS.toFixed(1)} s` : "",
  ].filter(Boolean);
  return (
    <p className="set-note lyr-status">
      <span className="lyr-dot" aria-hidden /> {head}
      {nums.length > 0 && <> · {nums.join(" · ")}</>}
    </p>
  );
}
