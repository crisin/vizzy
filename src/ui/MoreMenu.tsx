import { useEffect, useRef, useState, type ReactNode } from "react";

export type MenuItem =
  | {
      label: string;
      /** shown on the right, e.g. "R" */
      keyHint?: string;
      onSelect: () => void;
      /** a toggle: shows ✓ when on */
      checked?: boolean;
      disabled?: boolean;
      title?: string;
    }
  | { separator: true };

/**
 * A small popover menu under a toolbar button. Closes on choice, on Esc
 * (without letting Esc reach the app) and on a click elsewhere.
 */
export function MoreMenu({
  label,
  title,
  items,
  className = "",
  align = "right",
}: {
  label: ReactNode;
  title: string;
  items: MenuItem[];
  className?: string;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      setOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div className={`menu-wrap ${className}`} ref={rootRef}>
      <button
        type="button"
        className={`mode-btn ${open ? "active" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {label}
      </button>
      {open && (
        <div className={`menu-pop menu-${align}`} role="menu">
          {items.map((it, i) =>
            "separator" in it ? (
              <div key={`sep-${i}`} className="menu-sep" role="separator" />
            ) : (
              <button
                key={it.label}
                type="button"
                role={it.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                aria-checked={it.checked}
                className="menu-item"
                disabled={it.disabled}
                title={it.title}
                onClick={() => {
                  setOpen(false);
                  it.onSelect();
                }}
              >
                <span className="menu-check" aria-hidden="true">
                  {it.checked ? "✓" : ""}
                </span>
                <span className="menu-label">{it.label}</span>
                {it.keyHint && <kbd className="menu-key">{it.keyHint}</kbd>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
