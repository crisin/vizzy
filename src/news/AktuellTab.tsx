// The "Aktuell" tab of the settings drawer: what is new, newest first,
// with the controls each feature brought — adjustable right here — and a
// link to where they live for good. A view onto existing controls, not a
// second home for them (PLAN-ux.md, "Aktuell").

import { useEffect, useReducer, useState, type ReactNode } from "react";
import { keyLabel } from "../keys";
import { Section, revealSection } from "../ui/ParamRow";
import { renderControl } from "../ui/SettingsSearch";
import { VISIBLE_NEWS, newsSeen, type AppControlId, type NewsEntry } from "./news";

const DAY = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "long", year: "numeric" });

function dayLabel(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  return Number.isNaN(d.getTime()) ? date : DAY.format(d);
}

export function AktuellTab({
  app,
  onTab,
}: {
  /** the drawer's app-state switches, the same elements its tabs show */
  app: Record<AppControlId, ReactNode>;
  onTab: (tab: string) => void;
}) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  // what was new when the tab opened keeps its badge for this visit; the
  // dot on ⚙ goes right away
  const [fresh] = useState(() => new Set(newsSeen.unseen()));
  useEffect(() => newsSeen.markAll(), []);

  const goHome = (e: NewsEntry) => {
    if (!e.home) return;
    onTab(e.home.tab);
    if (e.home.section) revealSection(e.home.section);
  };

  if (VISIBLE_NEWS.length === 0) {
    return <p className="set-note">Gerade nichts Neues. Alle Einstellungen stehen in den Tabs daneben.</p>;
  }

  const days = [...new Set(VISIBLE_NEWS.map((e) => e.date))];
  return (
    <div className="news">
      <p className="set-note">
        Was neu ist, mit den Reglern dazu — hier direkt einstellbar. Jeder Regler steht auch an seinem festen
        Platz; der Link unter dem Eintrag führt hin.
      </p>
      {days.map((date, i) => {
        const entries = VISIBLE_NEWS.filter((e) => e.date === date);
        const news = entries.filter((e) => fresh.has(e.id)).length;
        return (
          <Section
            key={date}
            id={`news.${date}`}
            title={dayLabel(date)}
            badge={news ? `${news} neu` : undefined}
            defaultOpen={i < 2 || news > 0}
          >
            {entries.map((e) => {
              const controls = (e.controls ?? []).map((c) => renderControl(c, app, bump)).filter(Boolean);
              return (
                <article key={e.id} className={`news-item ${fresh.has(e.id) ? "fresh" : ""}`}>
                  <h3 className="news-title">
                    {e.title}
                    {e.key && <kbd className="news-key">{keyLabel(e.key)}</kbd>}
                  </h3>
                  <p className="set-note">{e.text}</p>
                  {controls.length > 0 && <div className="news-controls">{controls}</div>}
                  {e.home && (
                    <button type="button" className="news-home" onClick={() => goHome(e)}>
                      {e.home.label} →
                    </button>
                  )}
                </article>
              );
            })}
          </Section>
        );
      })}
    </div>
  );
}
