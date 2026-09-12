import { describe, expect, it } from 'vitest';
import { detectOS, ModelManager, resolveModelPath } from './modelManager';

describe('resolveModelPath', () => {
  it('uses %APPDATA%/VibeSpace/models/jarvis-high on Windows', () => {
    const p = resolveModelPath('windows', { APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' });
    expect(p).toBe('C:\\Users\\dev\\AppData\\Roaming\\VibeSpace\\models\\jarvis-high');
  });

  it('uses ~/Library/Application Support on macOS', () => {
    const p = resolveModelPath('macos', { HOME: '/Users/dev' });
    expect(p).toBe('/Users/dev/Library/Application Support/VibeSpace/models/jarvis-high');
  });

  it('uses ~/.local/share on Linux', () => {
    const p = resolveModelPath('linux', { HOME: '/home/dev' });
    expect(p).toBe('/home/dev/.local/share/VibeSpace/models/jarvis-high');
  });
});

describe('Jarvis High manifest', () => {
  it('pins the verified Piper artifacts from the authoritative model source', async () => {
    const manifest = await ModelManager.getModelManifest();

    expect(manifest).toMatchObject({
      model: 'jarvis-high',
      runtime: 'piper',
      sourceUrl: 'https://huggingface.co/jgkawell/jarvis/tree/main/en/en_GB/jarvis/high',
      files: [
        {
          name: 'jarvis-high.onnx',
          size_bytes: 114_199_011,
          sha256: '9791877d9c099fabbf30be2825e011451c39b3431e21e81e866f5b6507e72993',
        },
        {
          name: 'jarvis-high.onnx.json',
          size_bytes: 7_262,
          sha256: 'd0b8772d81c1da2fcdfd79e90bff027f46f040450e1deb89b43a9f6b1946c5a7',
        },
      ],
    });
  });
});

describe('detectOS', () => {
  it('detects windows', () => {
    expect(detectOS('Win32')).toBe('windows');
    expect(detectOS('windows')).toBe('windows');
  });
  it('detects macos', () => {
    expect(detectOS('MacIntel')).toBe('macos');
    expect(detectOS('darwin')).toBe('macos');
  });
  it('defaults to linux', () => {
    expect(detectOS('Linux x86_64')).toBe('linux');
    expect(detectOS('')).toBe('linux');
  });
});
