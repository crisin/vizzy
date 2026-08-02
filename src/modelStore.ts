// IndexedDB library for the user's 3D models — localStorage is far too
// small for GLB/ZIP binaries, IndexedDB handles large ArrayBuffers natively.

const DB_NAME = "vizzy";
const STORE = "models";
const VERSION = 2;

export type ModelRecord = {
  id?: number;
  name: string;
  data: ArrayBuffer;
  size: number;
  addedAt: number;
};

export type ModelMeta = { id: number; name: string; size: number };

function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      }
      // v1 kept a single model in a "files" store — superseded
      if (db.objectStoreNames.contains("files")) {
        db.deleteObjectStore("files");
      }
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    };
  });
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
      records.map((r) => ({ id: r.id!, name: r.name, size: r.size })),
  );
}

export function getModel(id: number): Promise<ModelRecord | undefined> {
  return withStore<ModelRecord | undefined>("readonly", (s) => s.get(id));
}

export function deleteModel(id: number): Promise<undefined> {
  return withStore<undefined>("readwrite", (s) => s.delete(id));
}

export function clearAllModels(): Promise<undefined> {
  return withStore<undefined>("readwrite", (s) => s.clear());
}
