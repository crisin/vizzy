// "Aufnahmen" in the Lyrics tab: the switch, the list of takes and their
// way to Lyrics Helper (PLAN-aufnahme.md).

import { useEffect } from "react";
import { Section } from "../ui/ParamRow";
import { lyrics, useLyrics } from "./store";
import { useNewHelper } from "../regie/newHelper";
import { heardShare, takeState, takes, useTakes, useTakesUi, type TakeEntry } from "./takes";

const DAY = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : DAY.format(d);
}

function describe(e: TakeEntry): string {
  const t = e.take;
  const share = heardShare(t);
  const heard = share === null ? `${Math.round(t.heardMs / 60_000)} min gehört` : `${Math.round(share * 100)} % des Songs`;
  return [
    when(t.recordedAt),
    `${t.lines.length} Zeilen`,
    heard,
    t.clock === "media" ? null : "Zeiten nur grob (keine Wiedergabeposition)",
    { noId: "ohne Spotify-ID, bleibt lokal", local: null, uploaded: `hochgeladen ${t.uploaded ? when(t.uploaded.at) : ""}`, changed: "seit dem Hochladen geändert" }[
      takeState(t)
    ],
  ]
    .filter(Boolean)
    .join(" · ");
}

export function TakesSection({ offerUndo }: { offerUndo?: (msg: string, run: () => void) => void }) {
  const s = useLyrics();
  const list = useTakes();
  const ui = useTakesUi();
  const nh = useNewHelper();
  const connected = !!nh.status.baseUrl && nh.status.hasToken;
  useEffect(() => {
    void takes.refresh();
  }, []);

  const remove = (e: TakeEntry) => {
    void takes.remove(e).then((undo) => offerUndo?.(`Aufnahme „${e.take.title}“ gelöscht`, undo));
  };

  return (
    <Section id="lyrics.takes" title="Aufnahmen" badge={list.length ? String(list.length) : undefined}>
      <label className="set-row set-row-toggle">
        <input
          type="checkbox"
          checked={s.cfg.takes}
          onChange={(e) => lyrics.configure({ takes: e.target.checked })}
        />
        <span className="set-label">
          Pro Song mitschreiben
          <small className="set-hint">
            Was gehört wurde, mit der Zeit im Song — eine Datei pro Song in <code>lyrics-takes/</code>. Als
            grober Entwurf für Lyrics Helper. Songs, von denen weniger als 40 % oder weniger als 5 Zeilen
            gehört wurden, werden nicht aufgehoben.
          </small>
        </span>
      </label>
      <label className="set-row set-row-select">
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
          value={s.cfg.takesUpload}
          disabled={!connected}
          onChange={(e) => lyrics.configure({ takesUpload: Number(e.target.value) })}
        >
          <option value={0}>Nur von Hand</option>
          <option value={1}>Automatisch, wenn dort synchroner Text fehlt</option>
          <option value={2}>Automatisch, immer</option>
        </select>
      </label>
      {list.length === 0 ? (
        <p className="set-note">
          Noch keine Aufnahme. Sie entsteht von selbst, sobald Lyrics an sind und ein Song zu einem guten Teil
          gelaufen ist.
        </p>
      ) : (
        <ul className="lyr-takes">
          {list.map((e) => (
            <li key={e.name} className="lyr-take">
              <span className="lyr-take-text">
                <span className="lyr-take-title">
                  {e.take.artist ? `${e.take.artist} – ${e.take.title}` : e.take.title}
                </span>
                <small className="set-hint">{describe(e)}</small>
                {ui.errors[e.name] && (
                  <small className="set-hint lyr-take-error" role="alert">
                    {ui.errors[e.name]}
                  </small>
                )}
              </span>
              {takeState(e.take) !== "noId" && (
                <button
                  type="button"
                  className="mode-btn"
                  disabled={!connected || ui.busy[e.name] || takeState(e.take) === "uploaded"}
                  title={
                    !connected
                      ? "Lyrics Helper ist nicht verbunden"
                      : takeState(e.take) === "uploaded"
                        ? "Liegt schon in Lyrics Helper"
                        : "An Lyrics Helper senden — dort als Entwurf neben dem Song"
                  }
                  onClick={() => void takes.upload(e.name)}
                >
                  {ui.busy[e.name] ? "Lädt hoch …" : takeState(e.take) === "uploaded" ? "Hochgeladen" : "Hochladen"}
                </button>
              )}
              <button
                type="button"
                className="mode-btn"
                title="Aufnahme löschen (mit Rückgängig)"
                aria-label={`Aufnahme ${e.take.title} löschen`}
                onClick={() => remove(e)}
              >
                Löschen
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="set-seg">
        <button type="button" className="mode-btn" onClick={() => takes.openFolder()} disabled={s.demo}>
          Ordner öffnen
        </button>
      </div>
    </Section>
  );
}
