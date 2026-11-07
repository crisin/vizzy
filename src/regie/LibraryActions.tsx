// Library side panel: queue and pool actions for the selected preset(s).

import { useState } from "react";
import { queue } from "./queue";
import { regie, useRegie } from "./regieStore";

export function LibraryActions({ keys }: { keys: string[] }) {
  const { pools } = useRegie();
  const [note, setNote] = useState("");
  const many = keys.length > 1;

  const flash = (msg: string) => {
    setNote(msg);
    window.setTimeout(() => setNote((n) => (n === msg ? "" : n)), 2000);
  };

  return (
    <div className="mdlib-actions">
      {!many && (
        <button
          type="button"
          className="mode-btn"
          onClick={() => {
            queue.addNext(keys[0]);
            flash("✓ als Nächstes");
          }}
          title="Kommt beim nächsten Wechsel dran"
        >
          ▶ Als Nächstes
        </button>
      )}
      <button
        type="button"
        className="mode-btn"
        onClick={() => {
          for (const k of keys) queue.add(k);
          flash(many ? `✓ ${keys.length} eingereiht` : "✓ eingereiht");
        }}
        title="Ans Ende der Queue (Q im Live-Bild)"
      >
        + {many ? `Alle einreihen (${keys.length})` : "Einreihen"}
      </button>
      <select
        className="src-select"
        value=""
        onChange={(e) => {
          const v = e.target.value;
          if (v === "__new") {
            const p = regie.createPool(`Pool ${pools.length + 1}`, keys);
            flash(`✓ neuer Pool „${p.name}“`);
          } else if (v) {
            for (const k of keys) regie.addToPool(v, k);
            flash(`✓ in „${pools.find((p) => p.id === v)?.name}“`);
          }
        }}
        aria-label="Zu Pool hinzufügen"
      >
        <option value="">Zu Pool …</option>
        {pools.map((p) => (
          <option key={p.id} value={p.id} disabled={keys.every((k) => p.entries.includes(k))}>
            {p.name} ({p.entries.length})
          </option>
        ))}
        <option value="__new">+ Neuer Pool</option>
      </select>
      {note && <span className="cockpit-note">{note}</span>}
    </div>
  );
}
