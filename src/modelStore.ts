// IndexedDB library for the user's 3D models — localStorage is far too
// small for GLB/ZIP binaries, IndexedDB handles large ArrayBuffers natively.

import { MODEL_STORE, withStore as withNamedStore } from "./idb";

export type ModelRecord = {
  id?: number;
  name: string;
  data: ArrayBuffer;
  size: number;
  addedAt: number;
  thumb?: string; // data-URL preview rendered at add time
};

export type ModelMeta = {
  id: number;
  name: string;
  size: number;
  thumb?: string;
};

function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return withNamedStore<T>(MODEL_STORE, mode, fn);
}

/** Store a model file (original bytes: .glb, .gltf or .zip). Returns its id. */
export function addModel(name: string, data: ArrayBuffer): Promise<number> {
  const record: ModelRecord = {
    name,
    data,
    size: data.byteLength,
    addedAt: Date.now(),
  };
  return withStore<IDBValidKey>("readwrite", (s) => s.add(record)).then(
    (key) => key as number,
  );
}

export function listModels(): Promise<ModelMeta[]> {
  return withStore<ModelRecord[]>("readonly", (s) => s.getAll()).then(
    (records) =>
      records.map((r) => ({
        id: r.id!,
        name: r.name,
        size: r.size,
        thumb: r.thumb,
      })),
  );
}

/** Attach a rendered preview to an existing record. */
export async function updateThumb(id: number, thumb: string): Promise<void> {
  const record = await getModel(id);
  if (!record) return;
  record.thumb = thumb;
  await withStore<IDBValidKey>("readwrite", (s) => s.put(record));
}

export function getModel(id: number): Promise<ModelRecord | undefined> {
  return withStore<ModelRecord | undefined>("readonly", (s) => s.get(id));
}

export function deleteModel(id: number): Promise<undefined> {
  return withStore<undefined>("readwrite", (s) => s.delete(id));
}

/** Puts a deleted record back under its old id (undo). */
export function restoreModel(record: ModelRecord): Promise<IDBValidKey> {
  return withStore<IDBValidKey>("readwrite", (s) => s.put(record));
}

export function clearAllModels(): Promise<undefined> {
  return withStore<undefined>("readwrite", (s) => s.clear());
}
