import { useEffect, useRef } from "react";
import { tagStore, useTags } from "./tags";
import { TagChips } from "./TagChips";

/**
 * Live tagging while listening: a strip along the bottom edge. Click a chip
 * or press 1–9 to toggle it on the preset that is playing; type and Enter
 * to make a new one. Stays open until T or Esc, so you can keep tagging as
 * the auto-switch moves on.
 */
export function TagBar({
  presetKey,
  label,
  onClose,
}: {
  presetKey: string;
  label: string;
  onClose: () => void;
}) {
  useTags();
  const keyRef = useRef(presetKey);
  keyRef.current = presetKey;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) {
        if (e.key === "Escape") t.blur();
        return;
      }
      if (e.key >= "1" && e.key <= "9" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const tag = tagStore.allTags()[Number(e.key) - 1];
        if (tag) tagStore.toggle(keyRef.current, tag.name);
        // the app's own 1–6 mode keys must not fire while tagging
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    // capture phase: runs before the app's global shortcut handler
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <div className="tagbar" role="toolbar" aria-label="Tags für das laufende Preset">
      <div className="tagbar-head">
        <span className="tagbar-name" title={presetKey}>{label}</span>
        <button type="button" className="mode-btn" onClick={onClose} title="Schließen (T)">×</button>
      </div>
      <TagChips
        selected={tagStore.get(presetKey)}
        onToggle={(t) => tagStore.toggle(presetKey, t)}
        allowCreate
        numbered
      />
    </div>
  );
}
