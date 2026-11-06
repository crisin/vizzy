// Shared IndexedDB handle. Both libraries — 3D models and parallax image
// pairs — live in the same database, so version and upgrade path have to be
// shared: opening one database at two different versions throws.

const DB_NAME = "vizzy";
const VERSION = 3;

export const MODEL_STORE = "models";
export const IMAGE_STORE = "images";

const STORES = [MODEL_STORE, IMAGE_STORE];

export function withStore<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: "id", autoIncrement: true });
        }
      }
      // v1 kept a single model in a "files" store — superseded
      if (db.objectStoreNames.contains("files")) {
        db.deleteObjectStore("files");
      }
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    };
  });
}
