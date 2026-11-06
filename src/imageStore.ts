// IndexedDB library for the parallax scene: a still image plus the depth map
// baked for it. The two are stored as one record because they only make sense
// together — a depth map belongs to exactly one framing of one picture.

import { IMAGE_STORE, withStore as withNamedStore } from "./idb";

export type ImageRecord = {
  id?: number;
  name: string;
  /** original image bytes (png/jpg/webp) */
  image: ArrayBuffer;
  imageType: string;
  /** baked depth map, same framing as the image; absent = derive a pseudo one */
  depth?: ArrayBuffer;
  depthType?: string;
  size: number;
  addedAt: number;
  /** data-URL preview for the library cards */
  thumb?: string;
};

export type ImageMeta = {
  id: number;
  name: string;
  size: number;
  hasDepth: boolean;
  thumb?: string;
};

function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return withNamedStore<T>(IMAGE_STORE, mode, fn);
}

export function addImage(
  name: string,
  image: ArrayBuffer,
  imageType: string,
): Promise<number> {
  const record: ImageRecord = {
    name,
    image,
    imageType,
    size: image.byteLength,
    addedAt: Date.now(),
  };
  return withStore<IDBValidKey>("readwrite", (s) => s.add(record)).then(
    (key) => key as number,
  );
}

export function listImages(): Promise<ImageMeta[]> {
  return withStore<ImageRecord[]>("readonly", (s) => s.getAll()).then(
    (records) =>
      records.map((r) => ({
        id: r.id!,
        name: r.name,
        size: r.size,
        hasDepth: r.depth != null,
        thumb: r.thumb,
      })),
  );
}

export function getImage(id: number): Promise<ImageRecord | undefined> {
  return withStore<ImageRecord | undefined>("readonly", (s) => s.get(id));
}

/** Attach (or replace) the baked depth map of an existing image. */
export async function setImageDepth(
  id: number,
  depth: ArrayBuffer,
  depthType: string,
): Promise<ImageRecord | undefined> {
  const record = await getImage(id);
  if (!record) return undefined;
  record.depth = depth;
  record.depthType = depthType;
  record.size = record.image.byteLength + depth.byteLength;
  await withStore<IDBValidKey>("readwrite", (s) => s.put(record));
  return record;
}

export async function updateImageThumb(
  id: number,
  thumb: string,
): Promise<void> {
  const record = await getImage(id);
  if (!record) return;
  record.thumb = thumb;
  await withStore<IDBValidKey>("readwrite", (s) => s.put(record));
}

export function deleteImage(id: number): Promise<undefined> {
  return withStore<undefined>("readwrite", (s) => s.delete(id));
}

export function clearAllImages(): Promise<undefined> {
  return withStore<undefined>("readwrite", (s) => s.clear());
}
