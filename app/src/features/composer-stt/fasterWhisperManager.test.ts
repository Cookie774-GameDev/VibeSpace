import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke, listen } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen }));

import { FasterWhisperManager } from './fasterWhisperManager';

describe('FasterWhisperManager download manifest', () => {
  beforeEach(() => {
    invoke.mockReset().mockImplementation(async (command: string) => {
      if (command === 'faster_whisper_model_path') return 'C:/models/base';
      if (command === 'fs_read_text') return '!\n"\n#\n';
      return undefined;
    });
    listen.mockReset().mockResolvedValue(() => undefined);
  });

  it('downloads the real vocabulary.txt and includes the legacy C2 installed-check alias', async () => {
    await expect(FasterWhisperManager.downloadModel('whisper-base-en-q5')).resolves.toBe(true);

    const call = invoke.mock.calls.find(([command]) => command === 'faster_whisper_download');
    expect(call).toBeDefined();
    const args = call?.[1] as {
      manifest: { files: Array<{ name: string; url: string; required: boolean }> };
    };
    const files = args.manifest.files;
    const vocabulary = files.find((file) => file.name === 'vocabulary.txt');
    const legacyAlias = files.find((file) => file.name === 'vocabulary.json');
    const sourceUrl =
      'https://huggingface.co/Systran/faster-whisper-base.en/resolve/main/vocabulary.txt';

    expect(vocabulary).toMatchObject({ name: 'vocabulary.txt', url: sourceUrl, required: true });
    expect(legacyAlias).toMatchObject({ name: 'vocabulary.json', url: sourceUrl, required: true });

    const compatibilityWrite = invoke.mock.calls.find(([command]) => command === 'fs_write_text');
    expect(compatibilityWrite?.[1]).toEqual({
      path: 'C:/models/base/vocabulary.json',
      content: JSON.stringify(['!', '"', '#']),
    });
  });
});
