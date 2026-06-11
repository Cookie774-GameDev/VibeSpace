import { describe, expect, it } from 'vitest';
import { detectOS, resolveModelPath } from './modelManager';

describe('resolveModelPath', () => {
  it('uses %APPDATA%/VibeSpace/models/kokoro on Windows', () => {
    const p = resolveModelPath('windows', { APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' });
    expect(p).toBe('C:\\Users\\dev\\AppData\\Roaming\\VibeSpace\\models\\kokoro');
  });

  it('uses ~/Library/Application Support on macOS', () => {
    const p = resolveModelPath('macos', { HOME: '/Users/dev' });
    expect(p).toBe('/Users/dev/Library/Application Support/VibeSpace/models/kokoro');
  });

  it('uses ~/.local/share on Linux', () => {
    const p = resolveModelPath('linux', { HOME: '/home/dev' });
    expect(p).toBe('/home/dev/.local/share/VibeSpace/models/kokoro');
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
