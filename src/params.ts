// Parameter system — the foundation of the visualization editor. Every
// visualization declares its tunable parameters as a schema; the editor
// panel renders them generically and values persist in localStorage.

export type ParamDef = {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
};

export const GROUP_LABELS: Record<string, string> = {
  audio: "Audio",
  render: "Rendering",
  bars: "Bars",
  radial: "Radial",
  scope: "Scope",
  orb: "Orb",
  terrain: "Terrain",
  tunnel: "Tunnel",
  bars3d: "3D-Bars",
  gyro: "Gyro",
  blob: "Blob",
  cubes: "Würfel",
  critters: "Tierchen",
  surf: "Surf",
  model: "Modell",
  milkdrop: "Milkdrop",
  layer: "Layer",
};

export const PARAM_SCHEMAS: Record<string, ParamDef[]> = {
  // Render resolution as % of native (CSS size × devicePixelRatio). Retina
  // fullscreen brings integrated GPUs to their knees — 50% quarters the
  // pixel count and Milkdrop/3D still look fine upscaled.
  render: [
    { key: "scale", label: "Auflösung (%)", min: 25, max: 100, step: 5, default: 100 },
    { key: "fpsCap", label: "FPS-Limit (120 = aus)", min: 15, max: 120, step: 5, default: 120 },
  ],
  audio: [
    { key: "gain", label: "Empfindlichkeit", min: 0.25, max: 4, step: 0.05, default: 1 },
    { key: "attack", label: "Ansprechzeit (ms)", min: 5, max: 200, step: 5, default: 35 },
    { key: "release", label: "Abklingzeit (ms)", min: 50, max: 1000, step: 10, default: 220 },
    { key: "beatSigma", label: "Beat-Schwelle (σ)", min: 0.5, max: 3, step: 0.1, default: 1.5 },
  ],
  bars: [
    { key: "height", label: "Höhe", min: 0.3, max: 1, step: 0.05, default: 0.72 },
    { key: "trail", label: "Trail-Stärke", min: 0.05, max: 0.9, step: 0.05, default: 0.35 },
  ],
  radial: [
    { key: "radius", label: "Radius", min: 0.1, max: 0.35, step: 0.01, default: 0.2 },
    { key: "spokes", label: "Strahlenlänge", min: 0.1, max: 0.5, step: 0.01, default: 0.26 },
    { key: "pulse", label: "Beat-Puls", min: 0, max: 0.5, step: 0.02, default: 0.12 },
    { key: "trail", label: "Trail-Stärke", min: 0.05, max: 0.9, step: 0.05, default: 0.35 },
  ],
  scope: [
    { key: "amp", label: "Amplitude", min: 0.1, max: 0.45, step: 0.01, default: 0.32 },
    { key: "glow", label: "Glow", min: 0, max: 30, step: 1, default: 12 },
    { key: "trail", label: "Trail-Stärke", min: 0.05, max: 0.9, step: 0.05, default: 0.35 },
  ],
  orb: [
    { key: "displace", label: "Ausschlag", min: 0.2, max: 1.5, step: 0.05, default: 0.65 },
    { key: "size", label: "Partikelgröße", min: 1, max: 8, step: 0.5, default: 3 },
    { key: "speed", label: "Rotation", min: 0, max: 0.6, step: 0.02, default: 0.12 },
    { key: "kick", label: "Beat-Kick", min: 0, max: 1.5, step: 0.05, default: 0.5 },
  ],
  terrain: [
    { key: "height", label: "Berghöhe", min: 6, max: 30, step: 1, default: 16 },
    { key: "speed", label: "Fluss (Reihen/s)", min: 10, max: 120, step: 5, default: 60 },
    { key: "sway", label: "Kameraschwenk", min: 0, max: 12, step: 1, default: 6 },
  ],
  tunnel: [
    { key: "speed", label: "Tempo", min: 10, max: 80, step: 2, default: 35 },
    { key: "twist", label: "Verdrehung", min: 0, max: 0.2, step: 0.01, default: 0.06 },
    { key: "pulse", label: "Beat-Boost", min: 0, max: 3, step: 0.1, default: 1.2 },
  ],
  bars3d: [
    { key: "height", label: "Balkenhöhe", min: 2, max: 16, step: 0.5, default: 8 },
    { key: "orbit", label: "Kamera-Orbit", min: 0, max: 0.6, step: 0.02, default: 0.15 },
  ],
  gyro: [
    { key: "speed", label: "Rotation", min: 0.1, max: 3, step: 0.1, default: 1 },
    { key: "kick", label: "Beat-Kick", min: 0, max: 3, step: 0.1, default: 1 },
  ],
  blob: [
    { key: "amp", label: "Verformung", min: 0.1, max: 1.2, step: 0.05, default: 0.5 },
    { key: "freq", label: "Detail", min: 0.8, max: 6, step: 0.1, default: 2.2 },
    { key: "speed", label: "Tempo", min: 0.1, max: 3, step: 0.1, default: 1 },
  ],
  cubes: [
    { key: "speed", label: "Rotation", min: 0.1, max: 3, step: 0.1, default: 1 },
    { key: "spread", label: "Größenstufe", min: 1.1, max: 2, step: 0.05, default: 1.45 },
    { key: "kick", label: "Beat-Kick", min: 0, max: 3, step: 0.1, default: 1 },
  ],
  critters: [
    { key: "bounce", label: "Hüpfen", min: 0, max: 2, step: 0.1, default: 1 },
    { key: "wiggle", label: "Wackeln", min: 0, max: 2, step: 0.1, default: 1 },
    { key: "spin", label: "Bühnen-Drehung", min: 0, max: 0.5, step: 0.02, default: 0.08 },
  ],
  surf: [
    { key: "height", label: "Wellenhöhe", min: 6, max: 30, step: 1, default: 14 },
    { key: "speed", label: "Wellentempo", min: 10, max: 120, step: 5, default: 60 },
    { key: "bounce", label: "Sprünge", min: 0, max: 2, step: 0.1, default: 1 },
  ],
  layer: [
    { key: "blur", label: "BG-Blur (px)", min: 0, max: 24, step: 1, default: 8 },
    { key: "dim", label: "BG-Helligkeit", min: 0.2, max: 1.2, step: 0.05, default: 0.9 },
    { key: "opacity", label: "Deckkraft vorne", min: 0.2, max: 1, step: 0.05, default: 1 },
  ],
  model: [
    { key: "spin", label: "Rotation", min: 0, max: 1.5, step: 0.05, default: 0.25 },
    { key: "pulse", label: "Bass-Puls", min: 0, max: 2, step: 0.05, default: 0.8 },
    { key: "light", label: "Licht-Reaktion", min: 0, max: 3, step: 0.1, default: 1.5 },
    { key: "explode", label: "Explosion 💥", min: 0, max: 3, step: 0.1, default: 1 },
  ],
  milkdrop: [
    { key: "blend", label: "Überblendzeit (s)", min: 0, max: 8, step: 0.1, default: 2.7 },
    { key: "cooldown", label: "Auto-Wechsel (s)", min: 5, max: 120, step: 5, default: 30 },
  ],
};

export const PARAMS_STORAGE_KEY = "vizzy.params.v1";
const STORAGE_KEY = PARAMS_STORAGE_KEY;

class ParamStore {
  private values: Record<string, Record<string, number>>;

  constructor() {
    try {
      this.values = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    } catch {
      this.values = {};
    }
  }

  /** modulation offsets applied on top of stored values ("group.key") */
  private mods: Record<string, number> = {};

  /** Effective value: stored/default + modulation, clamped to the def range. */
  get(group: string, key: string): number {
    const base = this.getBase(group, key);
    const mod = this.mods[`${group}.${key}`];
    if (!mod) return base;
    const def = PARAM_SCHEMAS[group]?.find((d) => d.key === key);
    if (!def) return base + mod;
    return Math.min(def.max, Math.max(def.min, base + mod));
  }

  /** Stored value without modulation (what the editor sliders show/edit). */
  getBase(group: string, key: string): number {
    const v = this.values[group]?.[key];
    if (v !== undefined && Number.isFinite(v)) return v;
    return PARAM_SCHEMAS[group]?.find((d) => d.key === key)?.default ?? 0;
  }

  clearMods() {
    this.mods = {};
  }

  addMod(group: string, key: string, offset: number) {
    const k = `${group}.${key}`;
    this.mods[k] = (this.mods[k] ?? 0) + offset;
  }

  set(group: string, key: string, value: number) {
    (this.values[group] ??= {})[key] = value;
    this.save();
  }

  reset(group: string) {
    delete this.values[group];
    this.save();
  }

  isDefault(group: string): boolean {
    return !this.values[group] || Object.keys(this.values[group]).length === 0;
  }

  private save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.values));
    } catch {
      // storage unavailable — values still apply for this session
    }
  }
}

export const params = new ParamStore();
