import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeSiyuanFilesystemPath } from './siyuanPathAuthority';

describe('Context safe restart uses the same normalized source authority', () => {
  it('normalizes a picker path for both the new checkpoint and its frontier', () => {
    const source = readFileSync(resolve(__dirname, '../ContextPage.tsx'), 'utf8');
    const start = source.indexOf('const restarted = createSiyuanIndexJob({');
    const end = source.indexOf('setIndexJobSnapshot(restarted)', start);
    const callback = source.slice(start, end);
    expect(callback).toContain('canonicalRoot: normalizeSiyuanFilesystemPath(restartMap.rootDir)');
    expect(callback).toContain('path: restarted.canonicalRoot');
    expect(normalizeSiyuanFilesystemPath(String.raw`\\?\C:\Users\viper\VibeSpace-Evidence`)).toBe(
      'C:/Users/viper/VibeSpace-Evidence',
    );
  });
});
