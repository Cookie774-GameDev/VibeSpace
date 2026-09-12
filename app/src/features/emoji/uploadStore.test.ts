import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_EMOJI_UPLOAD_BYTES,
  createEmojiAssetStore,
  validateEmojiUpload,
  type ImageDimensions,
} from './uploadStore';

const databases: string[] = [];

function pngFile(name = 'agent.png', bytes = 32): File {
  const data = new Uint8Array(Math.max(bytes, 8));
  data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return new File([data], name, { type: 'image/png' });
}

const square = async (): Promise<ImageDimensions> => ({ width: 128, height: 128 });

afterEach(async () => {
  await Promise.all(
    databases.splice(0).map(
      (name) =>
        new Promise<void>((resolve) => {
          const request = indexedDB.deleteDatabase(name);
          request.onsuccess = () => resolve();
          request.onerror = () => resolve();
          request.onblocked = () => resolve();
        }),
    ),
  );
});

describe('custom emoji uploads', () => {
  it('accepts bounded square raster images and rejects unsafe inputs', async () => {
    await expect(validateEmojiUpload(pngFile(), square)).resolves.toEqual({
      width: 128,
      height: 128,
      mimeType: 'image/png',
      sizeBytes: 32,
    });

    await expect(
      validateEmojiUpload(
        new File([new Uint8Array(16)], 'fake.png', { type: 'image/png' }),
        square,
      ),
    ).rejects.toThrow('file signature');
    await expect(
      validateEmojiUpload(
        new File([new Uint8Array(MAX_EMOJI_UPLOAD_BYTES + 1)], 'huge.png', {
          type: 'image/png',
        }),
        square,
      ),
    ).rejects.toThrow('256 KB');
    await expect(
      validateEmojiUpload(pngFile(), async () => ({ width: 900, height: 64 })),
    ).rejects.toThrow('32–512');
    await expect(
      validateEmojiUpload(pngFile(), async () => ({ width: 256, height: 80 })),
    ).rejects.toThrow('roughly square');
  });

  it('persists stable uploads while rename and deletion remain reference-safe', async () => {
    const databaseName = `vibespace-emoji-test-${crypto.randomUUID()}`;
    databases.push(databaseName);
    const store = createEmojiAssetStore(databaseName);

    const saved = await store.save(pngFile('my-agent.png'), 'My agent', square);
    expect(saved.id).toMatch(/^upload:[a-f0-9-]+$/u);
    expect((await store.get(saved.id))?.data.byteLength).toBe(32);

    const renamed = await store.rename(saved.id, 'Renamed agent');
    expect(renamed?.id).toBe(saved.id);
    expect(renamed?.name).toBe('Renamed agent');
    expect(await store.list()).toEqual([renamed]);

    await store.remove(saved.id);
    expect(await store.get(saved.id)).toBeNull();
    expect(await store.list()).toEqual([]);
  });
});
