import { describe, expect, it } from 'vitest';
import { detectOS, resolveModelPath } from './modelManager';

describe('resolveModelPath', () => {
  it('uses %APPDATA%/Jarvis-One/models/kokoro on Windows', () => {
    const p = resolveModelPath('windows', { APPDATA: 'C:\\Users\\viper\\AppData\\Roaming' });
    expect(p).toBe('C:\\Users\\viper\\AppData\\Roaming\\Jarvis-One\\models\\kokoro');
  });

  it('uses ~/Library/Application Support on macOS', () => {
    const p = resolveModelPath('macos', { HOME: '/Users/viper' });
    expect(p).toBe('/Users/viper/Library/Application Support/Jarvis-One/models/kokoro');
  });

  it('uses ~/.local/share on Linux', () => {
    const p = resolveModelPath('linux', { HOME: '/home/viper' });
    expect(p).toBe('/home/viper/.local/share/Jarvis-One/models/kokoro');
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
