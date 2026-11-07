// Live queue: "next this, then that" while it plays. Beats every rule and
// the auto-switch; each entry gets one slot — until the next musical
// boundary (the same moment the auto-switch would change) or a song change.
// Runtime only, not saved: it is about this evening, not a library.

import { useSyncExternalStore } from "react";

export type QueueItem = {
  id: number;
  /** preset key, or `combo:<name>` */
  ref: string;
};

let nextId = 1;

class QueueStore {
  private items: QueueItem[] = [];
  private listeners = new Set<() => void>();

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = () => this.items;

  /** cheap check for the render loop */
  get length() {
    return this.items.length;
  }

  private set(items: QueueItem[]) {
    this.items = items;
    for (const fn of this.listeners) fn();
  }

  /** at the end */
  add(ref: string) {
    this.set([...this.items, { id: nextId++, ref }]);
  }

  /** as the very next one */
  addNext(ref: string) {
    this.set([{ id: nextId++, ref }, ...this.items]);
  }

  remove(id: number) {
    this.set(this.items.filter((i) => i.id !== id));
  }

  move(id: number, to: number) {
    const items = [...this.items];
    const from = items.findIndex((i) => i.id === id);
    if (from < 0) return;
    const [it] = items.splice(from, 1);
    items.splice(Math.max(0, Math.min(items.length, to)), 0, it);
    this.set(items);
  }

  clear() {
    if (this.items.length) this.set([]);
  }

  shift(): QueueItem | undefined {
    const [first, ...rest] = this.items;
    if (first) this.set(rest);
    return first;
  }
}

export const queue = new QueueStore();

export function useQueue(): QueueItem[] {
  return useSyncExternalStore(queue.subscribe, queue.getSnapshot);
}
