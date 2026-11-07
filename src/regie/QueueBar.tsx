// Mini queue (bottom right): shows up as soon as something is queued.
// Drag to reorder, ✕ to drop, ▶ to play the next one now.
// Keys: Q queue the running picture · N next now · Shift+Q clear.

import { useState } from "react";
import { director } from "./director";
import { queue, useQueue } from "./queue";
import { COMBO_PREFIX } from "./regieStore";

type Props = {
  label: (key: string) => string;
  autoSwitch: boolean;
};

function short(s: string, n = 34): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function QueueBar({ label, autoSwitch }: Props) {
  const items = useQueue();
  const [drag, setDrag] = useState<number | null>(null);
  if (items.length === 0) return null;

  const name = (ref: string) =>
    ref.startsWith(COMBO_PREFIX) ? `Kombi: ${ref.slice(COMBO_PREFIX.length)}` : label(ref);

  return (
    <div className="queue-bar" role="region" aria-label="Warteschlange">
      <div className="queue-head">
        <span className="cockpit-label">Queue · {items.length}</span>
        <span className="regie-dim" title={autoSwitch ? undefined : "Läuft auch ohne Auto-Switch weiter"}>
          wechselt im Takt
        </span>
        <span className="cockpit-spacer" />
        <button
          type="button"
          className="mode-btn"
          onClick={() => director.playNextQueued()}
          title="Nächsten Eintrag sofort (N)"
          aria-keyshortcuts="N"
        >
          ▶ jetzt
        </button>
        <button
          type="button"
          className="mode-btn"
          onClick={() => queue.clear()}
          title="Queue leeren (Shift+Q)"
          aria-keyshortcuts="Shift+Q"
        >
          leeren
        </button>
      </div>
      <ol className="queue-list">
        {items.map((it, i) => (
          <li
            key={it.id}
            className={`queue-item ${drag === it.id ? "is-drag" : ""}`}
            draggable
            onDragStart={(e) => {
              setDrag(it.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragEnd={() => setDrag(null)}
            onDragOver={(e) => {
              if (drag === null || drag === it.id) return;
              e.preventDefault();
              queue.move(drag, i);
            }}
            title={name(it.ref)}
          >
            <span className="rule-prio">{i + 1}</span>
            <span className="queue-name">{short(name(it.ref))}</span>
            <button
              type="button"
              className="queue-x"
              onClick={() => queue.remove(it.id)}
              aria-label={`${name(it.ref)} aus der Queue nehmen`}
            >
              ✕
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
