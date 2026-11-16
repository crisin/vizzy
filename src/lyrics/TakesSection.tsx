// "Aufnahmen" in the Lyrics tab: the switch and the list of takes
// (PLAN-aufnahme.md). Uploading to Lyrics Helper comes with a later step.

import { useEffect } from "react";
import { Section } from "../ui/ParamRow";
import { lyrics, useLyrics } from "./store";
import { heardShare, takes, useTakes, type TakeEntry } from "./takes";

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
    t.spotifyId ? null : "ohne Spotify-ID",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function TakesSection({ offerUndo }: { offerUndo?: (msg: string, run: () => void) => void }) {
  const s = useLyrics();
  const list = useTakes();
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
              </span>
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
