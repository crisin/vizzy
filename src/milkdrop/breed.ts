// Breeding mode for the auto-switch: now and then, instead of a preset from
// the pool, play a freshly mutated child of it. Children live in memory under
// `breed:<n>` keys; the ones you like (`+`) become files, the ones you don't
// (`-`) count against their parent. Over time the ratings steer the
// auto-switch towards presets — and lineages — you actually enjoy.

import { mutate, probe } from "./remix";
import { compose, makePreset, type VizzyPreset } from "./vpreset";

export const BREED_PREFIX = "breed:";
const MAX_CHILDREN = 30;

const children = new Map<string, { preset: VizzyPreset; parent: string }>();
let counter = 0;

export function isBreedKey(key: string): boolean {
  return key.startsWith(BREED_PREFIX);
}

export function breedChild(key: string) {
  return children.get(key);
}

/** Resolves a breed key like any other preset key. */
export function resolveBreed(key: string, resolve: (k: string, depth: number) => unknown | null, depth: number) {
  const c = children.get(key);
  return c ? compose(c.preset, resolve, depth) : null;
}

/**
 * Mutates `parentKey` and probe-renders the result; resolves to the child's
 * key, or null when nothing usable came out in a few tries.
 */
export async function spawn(
  parentKey: string,
  parentTitle: string,
  resolve: (k: string) => unknown | null,
  opts: { strength: number; code: boolean },
): Promise<string | null> {
  const composed = resolve(parentKey) as Record<string, unknown> | null;
  if (!composed) return null;
  const seed0 = makePreset(parentTitle, parentKey);
  for (let attempt = 0; attempt < 3; attempt++) {
    const child = mutate(seed0, composed, {
      strength: opts.strength,
      code: opts.code,
      seed: (Date.now() + attempt * 104729) | 0,
      parentKey,
    });
    const n = ++counter;
    child.name = `${parentTitle} · Zucht ${n}`;
    const resolved = compose(child, (k) => resolve(k));
    if (!resolved) return null;
    const res = await probe(resolved);
    if (!res.ok) continue;
    const key = `${BREED_PREFIX}${n}`;
    children.set(key, { preset: child, parent: parentKey });
    while (children.size > MAX_CHILDREN) {
      const oldest = children.keys().next().value as string;
      children.delete(oldest);
    }
    return key;
  }
  return null;
}
