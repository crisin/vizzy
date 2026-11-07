import { useState } from "react";
import { RESERVED_TAGS, tagStore, useTags } from "./tags";
import "./library.css";

/** Every known tag as a toggle chip; optionally an input for a new one. */
export function TagChips({
  selected,
  partial = [],
  suggested,
  onToggle,
  allowCreate = false,
  compact = false,
  numbered = false,
}: {
  selected: string[];
  /** shown half-on (some of a multi-selection have it) */
  partial?: string[];
  /** dashed outline: measured suggestion */
  suggested?: string;
  onToggle: (tag: string) => void;
  allowCreate?: boolean;
  /** filter row: adds ★ and keeps chips small */
  compact?: boolean;
  /** show 1–9 hints on the first nine chips */
  numbered?: boolean;
}) {
  useTags();
  const [draft, setDraft] = useState("");
  const tags = tagStore.allTags();
  const list = compact ? [{ name: "★", color: "#facc15" }, ...tags] : tags;

  return (
    <div className={`tagchips ${compact ? "compact" : ""}`}>
      {list.map((t, i) => {
        const on = selected.includes(t.name);
        const half = !on && partial.includes(t.name);
        const sug = !on && suggested === t.name;
        return (
          <button
            key={t.name}
            type="button"
            className={`tagchip ${on ? "on" : ""} ${half ? "half" : ""} ${sug ? "suggest" : ""} ${RESERVED_TAGS.includes(t.name) ? "reserved" : ""}`}
            style={{ ["--c" as string]: t.color }}
            onClick={() => onToggle(t.name)}
            aria-pressed={on}
            title={sug ? "Vorschlag aus der Vorschau-Messung — klicken zum Übernehmen" : undefined}
          >
            {numbered && i < 9 && <kbd>{i + 1}</kbd>}
            {t.name}
          </button>
        );
      })}
      {allowCreate && (
        <form
          className="tagchip-new"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) onToggle(draft);
            setDraft("");
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="+ neuer Tag"
            aria-label="Neuer Tag"
          />
        </form>
      )}
    </div>
  );
}
