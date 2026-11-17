import { createContext, useContext, useEffect, useRef, useState } from "react";
import "./drawer.css";

/**
 * One numeric parameter: label, slider, a number field you can type into,
 * and a reset dot that shows when the value differs from its default.
 *
 * - Number field: Enter/blur commits, ↑/↓ step, Shift ×10, Alt ÷10.
 * - Slider: mouse wheel steps (Shift ×10), so fine moves don't need a drag.
 * - Double-click the label resets.
 */
export function ParamRow({
  label,
  hint,
  value,
  min,
  max,
  step,
  unit,
  defaultValue,
  changed,
  onChange,
  onReset,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  /** shown in the reset tooltip */
  defaultValue?: number;
  /** highlights the label; defaults to value !== defaultValue */
  changed?: boolean;
  onChange: (v: number) => void;
  onReset?: () => void;
}) {
  const decimals = step >= 1 ? 0 : Math.min(4, Math.max(1, Math.ceil(-Math.log10(step))));
  const fmt = (v: number) => v.toFixed(decimals);
  const [draft, setDraft] = useState(fmt(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(fmt(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, editing]);

  const isChanged = changed ?? (defaultValue !== undefined && Math.abs(value - defaultValue) > step / 2);
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step));
  const nudge = (dir: number, e: { shiftKey: boolean; altKey: boolean }) => {
    const mul = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
    // Alt drops below the slider's step for the number field only
    const s = step * mul;
    const next = Math.min(max, Math.max(min, value + dir * s));
    onChange(e.altKey ? Number(next.toFixed(decimals + 1)) : clamp(next));
  };

  const commitDraft = () => {
    setEditing(false);
    const v = Number(draft.replace(",", "."));
    if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
    else setDraft(fmt(value));
  };

  return (
    <div className={`prow ${isChanged ? "changed" : ""}`}>
      <span
        className="prow-label"
        onDoubleClick={onReset}
        title={hint ? `${hint}\n(Doppelklick: zurücksetzen)` : "Doppelklick: zurücksetzen"}
      >
        {label}
        {hint && <small className="prow-hint">{hint}</small>}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        onWheel={(e) => {
          if (document.activeElement !== e.currentTarget) return;
          e.preventDefault();
          nudge(e.deltaY < 0 ? 1 : -1, e);
        }}
      />
      <input
        className="prow-num"
        type="text"
        inputMode="decimal"
        value={draft}
        aria-label={`${label} Wert`}
        onFocus={(e) => {
          setEditing(true);
          e.currentTarget.select();
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitDraft}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commitDraft();
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            setEditing(false);
            setDraft(fmt(value));
            e.currentTarget.blur();
            e.stopPropagation();
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            setEditing(false);
            nudge(e.key === "ArrowUp" ? 1 : -1, e);
          }
        }}
      />
      {unit ? <span className="prow-unit">{unit}</span> : <span />}
      <button
        type="button"
        className="prow-reset"
        disabled={!isChanged || !onReset}
        onClick={onReset}
        title={defaultValue !== undefined ? `Zurück auf ${fmt(defaultValue)}` : "Zurücksetzen"}
        aria-label={`${label} zurücksetzen`}
      >
        ↺
      </button>
    </div>
  );
}

/** true while a filter is on that looks into every section ("nur
 *  Geändertes"): sections show their content whatever their own state */
export const ForceOpenContext = createContext(false);

/** the section a link wants to show; taken by the section when it mounts */
let pendingReveal: string | null = null;
const REVEAL_EVENT = "vizzy:reveal-section";

/** Opens the section `id`, scrolls it into view and lets it glow for a
 *  moment — also when it only mounts in a moment (a tab switch). */
export function revealSection(id: string) {
  pendingReveal = id;
  window.dispatchEvent(new Event(REVEAL_EVENT));
  // not there (another mode): don't let a later mount jump out of nowhere
  window.setTimeout(() => {
    if (pendingReveal === id) pendingReveal = null;
  }, 1000);
}

/** A collapsible group with a title, an optional count and a reset button.
 *  Open/closed is remembered per `id`. */
export function Section({
  id,
  title,
  badge,
  onReset,
  resetDisabled,
  defaultOpen = true,
  children,
}: {
  id: string;
  title: string;
  badge?: string;
  onReset?: () => void;
  resetDisabled?: boolean;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const storeKey = `vizzy.section.${id}`;
  const forced = useContext(ForceOpenContext);
  const [ownOpen, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(storeKey);
      return v == null ? defaultOpen : v === "1";
    } catch {
      return defaultOpen;
    }
  });
  const open = ownOpen || forced;
  const ref = useRef<HTMLElement | null>(null);
  const [glow, setGlow] = useState(false);
  useEffect(() => {
    let timer: number | undefined;
    const show = () => {
      if (pendingReveal !== id) return;
      pendingReveal = null;
      setOpen(true);
      setGlow(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setGlow(false), 1800);
      window.requestAnimationFrame(() => ref.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
    };
    show();
    window.addEventListener(REVEAL_EVENT, show);
    return () => {
      window.removeEventListener(REVEAL_EVENT, show);
      window.clearTimeout(timer);
    };
  }, [id]);
  const toggle = () => {
    setOpen((o) => {
      try {
        localStorage.setItem(storeKey, o ? "0" : "1");
      } catch {
        // ignore
      }
      return !o;
    });
  };
  return (
    <section ref={ref} className={`psec ${open ? "open" : ""} ${glow ? "reveal" : ""}`}>
      <div className="psec-head">
        <button type="button" className="psec-toggle" onClick={toggle} aria-expanded={open}>
          <span className="psec-caret">{open ? "▾" : "▸"}</span>
          {title}
          {badge && <span className="psec-badge">{badge}</span>}
        </button>
        {onReset && (
          <button type="button" className="mode-btn set-reset" disabled={resetDisabled} onClick={onReset}>
            Reset
          </button>
        )}
      </div>
      {open && <div className="psec-body">{children}</div>}
    </section>
  );
}
