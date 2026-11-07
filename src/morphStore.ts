// IndexedDB library for morph sets: N variants of *the same* picture, which
// the morph scene blends between according to the music. The frames are one
// record because they only mean anything together — order is the control
// surface, so a set with a frame missing is a different instrument.

import { MORPH_STORE, withStore as withNamedStore } from "./idb";

/** Beyond this the texture array stops being free; see `morph.ts`. */
export const MAX_FRAMES = 16;

export type MorphRecord = {
  id?: number;
  name: string;
  /** original image bytes, in control-surface order */
  frames: ArrayBuffer[];
  frameType: string;
  size: number;
  addedAt: number;
  thumb?: string;
};

export type MorphMeta = {
  id: number;
  name: string;
  size: number;
  frameCount: number;
  thumb?: string;
};

function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return withNamedStore<T>(MORPH_STORE, mode, fn);
}

export function addMorphSet(
  name: string,
  frames: ArrayBuffer[],
  frameType: string,
): Promise<number> {
  const record: MorphRecord = {
    name,
    frames,
    frameType,
    size: frames.reduce((n, f) => n + f.byteLength, 0),
    addedAt: Date.now(),
  };
  return withStore<IDBValidKey>("readwrite", (s) => s.add(record)).then(
    (key) => key as number,
  );
}

export function listMorphSets(): Promise<MorphMeta[]> {
  return withStore<MorphRecord[]>("readonly", (s) => s.getAll()).then(
    (records) =>
      records.map((r) => ({
        id: r.id!,
        name: r.name,
        size: r.size,
        frameCount: r.frames.length,
        thumb: r.thumb,
      })),
  );
}

export function getMorphSet(id: number): Promise<MorphRecord | undefined> {
  return withStore<MorphRecord | undefined>("readonly", (s) => s.get(id));
}

export async function updateMorphThumb(
  id: number,
  thumb: string,
): Promise<void> {
  const record = await getMorphSet(id);
  if (!record) return;
  record.thumb = thumb;
  await withStore<IDBValidKey>("readwrite", (s) => s.put(record));
}

export function deleteMorphSet(id: number): Promise<undefined> {
  return withStore<undefined>("readwrite", (s) => s.delete(id));
}

/** Puts a deleted record back under its old id (undo). */
export function restoreMorphSet(record: MorphRecord): Promise<IDBValidKey> {
  return withStore<IDBValidKey>("readwrite", (s) => s.put(record));
}

export function clearAllMorphSets(): Promise<undefined> {
  return withStore<undefined>("readwrite", (s) => s.clear());
}
