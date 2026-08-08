export const MAX_EMOJI_UPLOAD_BYTES = 256 * 1024;
const MIN_DIMENSION = 32;
const MAX_DIMENSION = 512;
const MAX_ASPECT_RATIO = 1.5;
const DEFAULT_DATABASE_NAME = 'vibespace-custom-emoji-v1';
const STORE_NAME = 'assets';
const DATABASE_VERSION = 1;
const TOKEN_RE = /^upload:[a-f0-9-]{8,80}$/u;
const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export type ImageDimensions = Readonly<{ width: number; height: number }>;
export type EmojiDimensionReader = (file: Blob) => Promise<ImageDimensions>;

export type CustomEmojiAsset = Readonly<{
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  data: ArrayBuffer;
  createdAt: number;
  updatedAt: number;
}>;

export type CustomEmojiSummary = Omit<CustomEmojiAsset, 'data'>;

function hasValidSignature(type: string, bytes: Uint8Array): boolean {
  if (type === 'image/png') {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return signature.every((value, index) => bytes[index] === value);
  }
  if (type === 'image/jpeg') {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (type === 'image/webp') {
    return (
      String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
      String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
    );
  }
  return false;
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer());
  return new Uint8Array(await new Response(blob).arrayBuffer());
}

function cleanName(value: string): string {
  const name = value
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .trim()
    .slice(0, 48);
  return name || 'Custom emoji';
}

function summary(asset: CustomEmojiAsset): CustomEmojiSummary {
  const { data: _data, ...rest } = asset;
  return rest;
}

export async function readEmojiDimensions(file: Blob): Promise<ImageDimensions> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file);
    try {
      return { width: bitmap.width, height: bitmap.height };
    } finally {
      bitmap.close();
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('The image could not be decoded.'));
    };
    image.src = url;
  });
}

export async function validateEmojiUpload(
  file: File,
  readDimensions: EmojiDimensionReader = readEmojiDimensions,
): Promise<Omit<CustomEmojiAsset, 'id' | 'name' | 'data' | 'createdAt' | 'updatedAt'>> {
  if (!ALLOWED_TYPES.has(file.type)) {
    throw new Error('Choose a PNG, JPEG, or WebP image.');
  }
  if (file.size < 8 || file.size > MAX_EMOJI_UPLOAD_BYTES) {
    throw new Error('Custom emojis must be no larger than 256 KB.');
  }
  const bytes = await blobBytes(file.slice(0, 16));
  if (!hasValidSignature(file.type, bytes)) {
    throw new Error('The image file signature does not match its declared type.');
  }
  const { width, height } = await readDimensions(file);
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < MIN_DIMENSION ||
    height < MIN_DIMENSION ||
    width > MAX_DIMENSION ||
    height > MAX_DIMENSION
  ) {
    throw new Error('Custom emoji dimensions must be between 32–512 pixels.');
  }
  const ratio = Math.max(width / height, height / width);
  if (ratio > MAX_ASPECT_RATIO) {
    throw new Error('Custom emojis must be roughly square.');
  }
  return { width, height, mimeType: file.type, sizeBytes: file.size };
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Custom emoji storage failed.'));
  });
}

function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('Custom emoji storage is unavailable.'));
      return;
    }
    const request = indexedDB.open(name, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Custom emoji storage failed.'));
  });
}

async function withStore<T>(
  databaseName: string,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const database = await openDatabase(databaseName);
  try {
    return await operation(database.transaction(STORE_NAME, mode).objectStore(STORE_NAME));
  } finally {
    database.close();
  }
}

export type EmojiAssetStore = ReturnType<typeof createEmojiAssetStore>;

export function createEmojiAssetStore(databaseName = DEFAULT_DATABASE_NAME) {
  return Object.freeze({
    async save(
      file: File,
      name: string,
      readDimensions: EmojiDimensionReader = readEmojiDimensions,
    ): Promise<CustomEmojiSummary> {
      const validated = await validateEmojiUpload(file, readDimensions);
      const now = Date.now();
      const fileBytes = await blobBytes(file);
      const asset: CustomEmojiAsset = {
        id: `upload:${crypto.randomUUID().toLowerCase()}`,
        name: cleanName(name || file.name.replace(/\.[^.]+$/u, '')),
        ...validated,
        data: fileBytes.slice().buffer as ArrayBuffer,
        createdAt: now,
        updatedAt: now,
      };
      await withStore(databaseName, 'readwrite', async (store) => {
        await requestResult(store.put(asset));
      });
      return summary(asset);
    },

    async get(id: string): Promise<CustomEmojiAsset | null> {
      if (!TOKEN_RE.test(id)) return null;
      return withStore(databaseName, 'readonly', async (store) => {
        const value = await requestResult(store.get(id));
        return (value as CustomEmojiAsset | undefined) ?? null;
      });
    },

    async list(): Promise<CustomEmojiSummary[]> {
      return withStore(databaseName, 'readonly', async (store) => {
        const values = (await requestResult(store.getAll())) as CustomEmojiAsset[];
        return values
          .sort(
            (left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id),
          )
          .map(summary);
      });
    },

    async rename(id: string, name: string): Promise<CustomEmojiSummary | null> {
      if (!TOKEN_RE.test(id)) return null;
      return withStore(databaseName, 'readwrite', async (store) => {
        const current = (await requestResult(store.get(id))) as CustomEmojiAsset | undefined;
        if (!current) return null;
        const next = { ...current, name: cleanName(name), updatedAt: Date.now() };
        await requestResult(store.put(next));
        return summary(next);
      });
    },

    async remove(id: string): Promise<void> {
      if (!TOKEN_RE.test(id)) return;
      await withStore(databaseName, 'readwrite', async (store) => {
        await requestResult(store.delete(id));
      });
    },
  });
}

export const emojiAssetStore = createEmojiAssetStore();
