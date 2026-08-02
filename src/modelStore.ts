// IndexedDB storage for the user's 3D model — localStorage is far too
// small for GLB binaries, IndexedDB handles large ArrayBuffers natively.

const DB_NAME = "vizzy";
const STORE = "files";
const MODEL_KEY = "model3d";

export type StoredModel = { name: string; data: ArrayBuffer };

function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore(STORE);
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

export function saveStoredModel(name: string, data: ArrayBuffer) {
  return withStore<IDBValidKey>("readwrite", (s) =>
    s.put({ name, data } satisfies StoredModel, MODEL_KEY),
  );
}

export function loadStoredModel() {
  return withStore<StoredModel | undefined>("readonly", (s) =>
    s.get(MODEL_KEY),
  );
}

export function clearStoredModel() {
  return withStore<undefined>("readwrite", (s) => s.delete(MODEL_KEY));
}
