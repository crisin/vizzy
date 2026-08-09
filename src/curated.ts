// Curated presets — Butterchurn presets with hand-tuned baseVals, shipped
// with the app. They behave like the user's own saved presets (a base preset
// plus overrides) but cannot be edited away; "Tweaks → Speichern" forks one
// into a user preset instead.
//
// The point is that Vizzy looks good the moment it is opened, without anyone
// having to hunt through 107 presets first.

export type CuratedPreset = {
  /** shown in the picker */
  name: string;
  /** key of the Butterchurn preset it derives from */
  base: string;
  /** baseVals applied on top of the base preset */
  overrides: Record<string, number>;
  /** why this one, and what was changed — for the next person tuning it */
  note: string;
};

export const CURATED_PREFIX = "vizzy:";

export const CURATED: CuratedPreset[] = [
  {
    name: "Kirchenfenster",
    base: "Eo.S. + Zylot - skylight (Stained Glass Majesty mix)",
    note:
      "Jewel-like stained glass with a slow spiral. Picked over the other " +
      "candidates for having real structure rather than a colour wash. " +
      "Longer decay so the glass glows instead of flickering, a visible " +
      "warm waveform threaded through the cool panes, and a touch more echo " +
      "for depth.",
    overrides: {
      decay: 0.98,
      wave_a: 0.45,
      wave_scale: 0.85,
      wave_smoothing: 0.75,
      wave_dots: 0,
      wave_r: 1.0,
      wave_g: 0.78,
      wave_b: 0.42,
      echo_zoom: 1.02,
      warp: 0.05,
    },
  },
];

export function findCurated(key: string): CuratedPreset | undefined {
  if (!key.startsWith(CURATED_PREFIX)) return undefined;
  const name = key.slice(CURATED_PREFIX.length);
  return CURATED.find((p) => p.name === name);
}

/** Key of the preset a fresh install starts on. */
export const DEFAULT_PRESET_KEY = `${CURATED_PREFIX}${CURATED[0].name}`;
