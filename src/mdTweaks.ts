// Milkdrop preset tweaking: curated baseVals with sane ranges, and
// storage for user presets (base preset + overrides).

export type TweakDef = {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
};

export const TWEAK_DEFS: TweakDef[] = [
  { key: "decay", label: "Decay (Nachleuchten)", min: 0.9, max: 1, step: 0.001 },
  { key: "zoom", label: "Zoom", min: 0.5, max: 1.5, step: 0.002 },
  { key: "zoomexp", label: "Zoom-Kurve", min: 0.5, max: 2, step: 0.01 },
  { key: "rot", label: "Rotation", min: -0.2, max: 0.2, step: 0.002 },
  { key: "warp", label: "Warp", min: 0, max: 3, step: 0.02 },
  { key: "cx", label: "Zentrum X", min: 0, max: 1, step: 0.01 },
  { key: "cy", label: "Zentrum Y", min: 0, max: 1, step: 0.01 },
  { key: "sx", label: "Stretch X", min: 0.9, max: 1.1, step: 0.002 },
  { key: "sy", label: "Stretch Y", min: 0.9, max: 1.1, step: 0.002 },
  { key: "wave_mode", label: "Wave-Form (0-7)", min: 0, max: 7, step: 1 },
  { key: "wave_a", label: "Wave-Alpha", min: 0, max: 4, step: 0.05 },
  { key: "wave_scale", label: "Wave-Größe", min: 0, max: 5, step: 0.05 },
  { key: "wave_smoothing", label: "Wave-Glättung", min: 0, max: 0.95, step: 0.05 },
  { key: "wave_r", label: "Wave Rot", min: 0, max: 1, step: 0.02 },
  { key: "wave_g", label: "Wave Grün", min: 0, max: 1, step: 0.02 },
  { key: "wave_b", label: "Wave Blau", min: 0, max: 1, step: 0.02 },
  { key: "wave_x", label: "Wave X", min: 0, max: 1, step: 0.01 },
  { key: "wave_y", label: "Wave Y", min: 0, max: 1, step: 0.01 },
  { key: "wave_mystery", label: "Wave Mystery", min: -1, max: 1, step: 0.02 },
  { key: "wave_dots", label: "Wave als Punkte", min: 0, max: 1, step: 1 },
  { key: "additivewave", label: "Wave additiv", min: 0, max: 1, step: 1 },
  { key: "echo_zoom", label: "Echo-Zoom", min: 0.5, max: 2, step: 0.01 },
  { key: "echo_alpha", label: "Echo-Stärke", min: 0, max: 1, step: 0.05 },
  { key: "echo_orient", label: "Echo-Spiegelung (0-3)", min: 0, max: 3, step: 1 },
  { key: "gammaadj", label: "Gamma", min: 1, max: 4, step: 0.05 },
  { key: "brighten", label: "Aufhellen", min: 0, max: 1, step: 1 },
  { key: "darken", label: "Abdunkeln", min: 0, max: 1, step: 1 },
];

export type UserPreset = {
  name: string;
  base: string; // key of the butterchurn preset it derives from
  overrides: Record<string, number>;
};

const STORAGE_KEY = "vizzy.mdpresets.v1";

export function loadUserPresets(): UserPreset[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function saveUserPreset(preset: UserPreset): UserPreset[] {
  const list = loadUserPresets().filter((p) => p.name !== preset.name);
  list.push(preset);
  list.sort((a, b) => a.name.localeCompare(b.name));
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // storage unavailable
  }
  return list;
}

export function deleteUserPreset(name: string): UserPreset[] {
  const list = loadUserPresets().filter((p) => p.name !== name);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // storage unavailable
  }
  return list;
}

export const MD_PRESETS_STORAGE_KEY = STORAGE_KEY;
