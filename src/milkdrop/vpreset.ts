// Vizzy's own preset format: a Milkdrop preset described as *parts*, each
// either taken from another preset or written inline.
//
// That one model carries everything that makes new presets out of old ones:
//   - a tweak is a base preset plus baseVals overrides
//   - a mashup takes the warp shader from X, the comp shader from Y, the
//     motion equations from Z (the classic Milkdrop mashup, by reference)
//   - a code edit turns one part inline
//   - mutation and crossing (remix.ts) rewrite parts and overrides
// and `lineage` remembers where it came from.
//
// `compose` resolves it to plain Butterchurn JSON.

export type PartRef = { from: string };
export type PartInline<T> = { inline: T };
export type Part<T> = PartRef | PartInline<T>;

export const CODE_PARTS = ["init", "frame", "pixel", "warp", "comp"] as const;
export type CodePart = (typeof CODE_PARTS)[number];

/** Butterchurn field per code part */
export const CODE_FIELD: Record<CodePart, string> = {
  init: "init_eqs_eel",
  frame: "frame_eqs_eel",
  pixel: "pixel_eqs_eel",
  warp: "warp",
  comp: "comp",
};

export const PART_LABELS: Record<string, string> = {
  baseVals: "Grundwerte",
  init: "Init-Gleichungen",
  frame: "Frame-Gleichungen",
  pixel: "Pixel-Gleichungen",
  warp: "Warp-Shader",
  comp: "Comp-Shader",
};

export type LineageOp = "tweak" | "mashup" | "mutate" | "cross" | "edit" | "ai" | "import";

export type VizzyPreset = {
  format: "vizzy-preset";
  version: 1;
  id: string;
  name: string;
  created: number;
  modified: number;
  /** default source for every part that is not given */
  base: string;
  parts: {
    baseVals?: Part<Record<string, number | string>>;
    init?: Part<string>;
    frame?: Part<string>;
    pixel?: Part<string>;
    warp?: Part<string>;
    comp?: Part<string>;
    /** one entry per wave/shape slot (4 each); null = from base */
    waves?: (Part<unknown> | null)[];
    shapes?: (Part<unknown> | null)[];
  };
  overrides: Record<string, number>;
  tags?: string[];
  lineage?: { parents: string[]; op: LineageOp; at: number; note?: string };
  rating?: number;
};

type Bc = Record<string, unknown> & {
  baseVals?: Record<string, unknown>;
  waves?: unknown[];
  shapes?: unknown[];
};

export function isRef<T>(p: Part<T> | null | undefined): p is PartRef {
  return !!p && typeof (p as PartRef).from === "string";
}

export function newId(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `${slug || "preset"}-${Math.random().toString(36).slice(2, 7)}`;
}

export function makePreset(name: string, base: string, init?: Partial<VizzyPreset>): VizzyPreset {
  const now = Date.now();
  return {
    format: "vizzy-preset",
    version: 1,
    id: newId(name),
    name,
    created: now,
    modified: now,
    base,
    parts: {},
    overrides: {},
    ...init,
  };
}

const clone = <T>(x: T): T => (x === undefined ? x : JSON.parse(JSON.stringify(x)));

/**
 * Resolves a Vizzy preset to Butterchurn JSON. `resolve` looks up any preset
 * key (Butterchurn, curated, user — so parts can come from other Vizzy
 * presets, too). `depth` guards against reference cycles.
 */
export function compose(
  vp: VizzyPreset,
  resolve: (key: string, depth: number) => unknown | null,
  depth = 0,
): Bc | null {
  if (depth > 6) return null;
  // an imported preset carries every part inline and has no base
  const base = (vp.base ? resolve(vp.base, depth + 1) : { baseVals: {}, waves: [], shapes: [] }) as Bc | null;
  if (!base) return null;
  const out = clone(base) as Bc;
  const from = (key: string) => resolve(key, depth + 1) as Bc | null;

  const bv = vp.parts.baseVals;
  if (bv) {
    const src = isRef(bv) ? from(bv.from)?.baseVals : bv.inline;
    if (src) out.baseVals = clone(src) as Record<string, unknown>;
  }
  for (const part of CODE_PARTS) {
    const p = vp.parts[part];
    if (!p) continue;
    const field = CODE_FIELD[part];
    const v = isRef(p) ? from(p.from)?.[field] : p.inline;
    if (typeof v === "string") out[field] = v;
  }
  for (const list of ["waves", "shapes"] as const) {
    const slots = vp.parts[list];
    if (!slots) continue;
    const arr = [...((out[list] as unknown[]) ?? [])];
    slots.forEach((p, i) => {
      if (!p) return;
      const v = isRef(p) ? (from(p.from)?.[list] as unknown[] | undefined)?.[i] : p.inline;
      if (v !== undefined) arr[i] = clone(v);
    });
    out[list] = arr;
  }
  out.baseVals = { ...(out.baseVals ?? {}), ...vp.overrides };
  return out;
}

/** The text of one code part as it resolves now (for the editor). */
export function codeOf(composed: Bc | null, part: CodePart): string {
  const v = composed?.[CODE_FIELD[part]];
  return typeof v === "string" ? v : "";
}

/** Wave/shape slot equations: Butterchurn keeps them per slot. */
export const SLOT_FIELDS = {
  waves: ["init_eqs_eel", "frame_eqs_eel", "point_eqs_eel"],
  shapes: ["init_eqs_eel", "frame_eqs_eel"],
} as const;

/** Every key referenced anywhere in the preset (for "uses" and cycles). */
export function referencedKeys(vp: VizzyPreset): string[] {
  const out = new Set<string>([vp.base]);
  const add = (p: Part<unknown> | null | undefined) => {
    if (isRef(p)) out.add(p.from);
  };
  add(vp.parts.baseVals);
  for (const k of CODE_PARTS) add(vp.parts[k]);
  vp.parts.waves?.forEach(add);
  vp.parts.shapes?.forEach(add);
  return [...out];
}

/** Old localStorage user presets (base + overrides) → Vizzy presets. */
export function fromLegacy(p: { name: string; base: string; overrides: Record<string, number> }): VizzyPreset {
  return makePreset(p.name, p.base, {
    overrides: { ...p.overrides },
    lineage: { parents: [p.base], op: "tweak", at: Date.now() },
  });
}

export function sanitize(x: unknown): VizzyPreset | null {
  const v = x as Partial<VizzyPreset> | null;
  if (!v || typeof v !== "object") return null;
  if (typeof v.name !== "string" || typeof v.base !== "string") return null;
  return {
    format: "vizzy-preset",
    version: 1,
    id: typeof v.id === "string" ? v.id : newId(v.name),
    name: v.name,
    created: Number(v.created) || Date.now(),
    modified: Number(v.modified) || Date.now(),
    base: v.base,
    parts: v.parts && typeof v.parts === "object" ? v.parts : {},
    overrides: v.overrides && typeof v.overrides === "object" ? v.overrides : {},
    tags: Array.isArray(v.tags) ? v.tags : undefined,
    lineage: v.lineage,
    rating: typeof v.rating === "number" ? v.rating : undefined,
  };
}
