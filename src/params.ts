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
  bars: "Bars",
  radial: "Radial",
  scope: "Scope",
  orb: "Orb",
  terrain: "Terrain",
  tunnel: "Tunnel",
  bars3d: "3D-Bars",
  gyro: "Gyro",
  blob: "Blob",
  model: "Modell",
  milkdrop: "Milkdrop",
};

export const PARAM_SCHEMAS: Record<string, ParamDef[]> = {
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
  model: [
    { key: "spin", label: "Rotation", min: 0, max: 1.5, step: 0.05, default: 0.25 },
    { key: "pulse", label: "Bass-Puls", min: 0, max: 2, step: 0.05, default: 0.8 },
    { key: "light", label: "Licht-Reaktion", min: 0, max: 3, step: 0.1, default: 1.5 },
  ],
  milkdrop: [
    { key: "blend", label: "Überblendzeit (s)", min: 0, max: 8, step: 0.1, default: 2.7 },
    { key: "cooldown", label: "Auto-Wechsel (s)", min: 5, max: 120, step: 5, default: 30 },
  ],
};

const STORAGE_KEY = "vizzy.params.v1";

class ParamStore {
  private values: Record<string, Record<string, number>>;

  constructor() {
    try {
      this.values = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    } catch {
      this.values = {};
    }
  }

  get(group: string, key: string): number {
    const v = this.values[group]?.[key];
    if (v !== undefined && Number.isFinite(v)) return v;
    return PARAM_SCHEMAS[group]?.find((d) => d.key === key)?.default ?? 0;
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
