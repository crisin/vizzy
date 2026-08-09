import { useLayoutEffect, useRef, type RefObject } from "react";

const FOCUSABLE = [
  "button:not([disabled])",
  "select:not([disabled])",
  "input:not([disabled])",
  "textarea:not([disabled])",
  '[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function useDialogFocus<T extends HTMLElement>(
  trap = true,
  returnFocusRef?: RefObject<HTMLElement | null>,
) {
  const ref = useRef<T | null>(null);

  useLayoutEffect(() => {
    const root = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    const returnTarget = returnFocusRef?.current ?? previous;
    if (!root) return;

    const focusable = () =>
      [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => !element.hidden && element.getClientRects().length > 0,
      );

    focusable()[0]?.focus();

    const keepFocusInside = (event: KeyboardEvent) => {
      if (!trap || event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || !root.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (active === last || !root.contains(active))
      ) {
        event.preventDefault();
        first.focus();
      }
    };

    if (trap) document.addEventListener("keydown", keepFocusInside, true);
    return () => {
      if (trap) document.removeEventListener("keydown", keepFocusInside, true);
      if (returnTarget?.isConnected) returnTarget.focus();
    };
  }, [trap, returnFocusRef]);

  return ref;
}
