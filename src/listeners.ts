// Frequency listeners + modulation routing. A listener watches a Hz range
// of the analysis bands and produces a smoothed 0..1 value; assignments
// route those values onto any editor parameter as an offset.

import { PARAM_SCHEMAS, params } from "./params";

// must match the Rust analyzer's band layout
const NUM_BANDS = 64;
const F_MIN = 40;
const F_MAX = 16000;

export type Listener = {
  id: number;
  name: string;
  from: number; // Hz
  to: number; // Hz
  gain: number;
  attack: number; // ms
  release: number; // ms
};

export type Assignment = {
  id: number;
  listenerId: number;
  group: string;
  key: string;
  amount: number; // -1..1 of the target's full range
};

type Stored = { listeners: Listener[]; assignments: Assignment[]; nextId: number };

const STORAGE_KEY = "vizzy.routing.v1";

function bandForHz(hz: number): number {
  const k = (NUM_BANDS * Math.log(hz / F_MIN)) / Math.log(F_MAX / F_MIN);
  return Math.min(NUM_BANDS - 1, Math.max(0, Math.round(k)));
}

const DEFAULTS: Stored = {
  listeners: [
    { id: 1, name: "Bass", from: 40, to: 140, gain: 1.2, attack: 30, release: 200 },
    { id: 2, name: "Mitten", from: 400, to: 2000, gain: 1, attack: 40, release: 250 },
    { id: 3, name: "Höhen", from: 6000, to: 16000, gain: 1.5, attack: 20, release: 180 },
  ],
  assignments: [],
  nextId: 4,
};

class ListenerEngine {
  listeners: Listener[];
  assignments: Assignment[];
  /** current smoothed values by listener id (read by the routing UI meters) */
  readonly values = new Map<number, number>();
  private nextId: number;

  constructor() {
    let stored: Stored | null = null;
    try {
      stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    } catch {
      stored = null;
    }
    this.listeners = stored?.listeners ?? DEFAULTS.listeners;
    this.assignments = stored?.assignments ?? DEFAULTS.assignments;
    this.nextId = stored?.nextId ?? DEFAULTS.nextId;
  }

  /** Called once per animation frame with the raw normalized bands. */
  update(bands: Float32Array, dt: number) {
    params.clearMods();
    for (const l of this.listeners) {
      const b0 = bandForHz(Math.min(l.from, l.to));
      const b1 = Math.max(b0, bandForHz(Math.max(l.from, l.to)));
      let sum = 0;
      for (let b = b0; b <= b1; b++) sum += bands[b] ?? 0;
      const target = Math.min(1.5, (sum / (b1 - b0 + 1)) * l.gain);

      const current = this.values.get(l.id) ?? 0;
      const tau = (target > current ? l.attack : l.release) / 1000;
      const k = 1 - Math.exp(-dt / Math.max(0.001, tau));
      this.values.set(l.id, current + (target - current) * k);
    }
    for (const a of this.assignments) {
      const def = PARAM_SCHEMAS[a.group]?.find((d) => d.key === a.key);
      if (!def) continue;
      const v = this.values.get(a.listenerId) ?? 0;
      params.addMod(a.group, a.key, v * a.amount * (def.max - def.min));
    }
  }

  addListener(): Listener {
    const l: Listener = {
      id: this.nextId++,
      name: `Listener ${this.nextId - 1}`,
      from: 200,
      to: 800,
      gain: 1,
      attack: 30,
      release: 200,
    };
    this.listeners.push(l);
    this.save();
    return l;
  }

  removeListener(id: number) {
    this.listeners = this.listeners.filter((l) => l.id !== id);
    this.assignments = this.assignments.filter((a) => a.listenerId !== id);
    this.values.delete(id);
    this.save();
  }

  addAssignment(): Assignment {
    const a: Assignment = {
      id: this.nextId++,
      listenerId: this.listeners[0]?.id ?? 1,
      group: "radial",
      key: "radius",
      amount: 0.3,
    };
    this.assignments.push(a);
    this.save();
    return a;
  }

  removeAssignment(id: number) {
    this.assignments = this.assignments.filter((a) => a.id !== id);
    this.save();
  }

  save() {
    try {
      const data: Stored = {
        listeners: this.listeners,
        assignments: this.assignments,
        nextId: this.nextId,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // storage unavailable — routing still works for this session
    }
  }
}

export const routing = new ListenerEngine();
export const ROUTING_STORAGE_KEY = STORAGE_KEY;
