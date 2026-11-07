import { useEffect, useState } from "react";
import { MoreMenu } from "./MoreMenu";

type Mode = { id: string; label: string; key: string };

const LAST_KEY = "vizzy.lastClassic";

/**
 * Milkdrop | 3D | Klassisch ▾ — the two big worlds get a button each, the
 * small 2D modes share one. Its name is the last 2D mode used, so one click
 * goes back to it; ▾ picks another.
 */
export function ModeSwitch({
  mode,
  primary,
  classic,
  onMode,
}: {
  mode: string;
  primary: Mode[];
  classic: Mode[];
  onMode: (id: string) => void;
}) {
  const [last, setLast] = useState(() => {
    try {
      const v = localStorage.getItem(LAST_KEY);
      return classic.some((c) => c.id === v) ? v! : classic[0].id;
    } catch {
      return classic[0].id;
    }
  });
  useEffect(() => {
    if (!classic.some((c) => c.id === mode)) return;
    setLast(mode);
    try {
      localStorage.setItem(LAST_KEY, mode);
    } catch {
      // ignore
    }
  }, [mode, classic]);

  const lastMode = classic.find((c) => c.id === last) ?? classic[0];
  const inClassic = classic.some((c) => c.id === mode);

  return (
    <div className="seg mode-switch" role="group" aria-label="Visualisierung">
      {primary.map((m) => (
        <button
          key={m.id}
          type="button"
          className={`mode-btn ${mode === m.id ? "active" : ""}`}
          onClick={() => onMode(m.id)}
          title={`${m.label} · Taste ${m.key}`}
          aria-pressed={mode === m.id}
          aria-keyshortcuts={m.key}
        >
          {m.label}
        </button>
      ))}
      <button
        type="button"
        className={`mode-btn ${inClassic ? "active" : ""}`}
        onClick={() => onMode(lastMode.id)}
        title={`Klassisch: ${lastMode.label} · Taste ${lastMode.key}`}
        aria-pressed={inClassic}
      >
        {lastMode.label}
      </button>
      <MoreMenu
        className="mode-more"
        label="▾"
        title="Klassische Modi"
        items={classic.map((c) => ({
          label: c.label,
          keyHint: c.key,
          checked: mode === c.id,
          onSelect: () => onMode(c.id),
        }))}
      />
    </div>
  );
}
