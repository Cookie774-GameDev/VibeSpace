import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const indexHtml = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
const prepaint = readFileSync(resolve(process.cwd(), 'public/theme-prepaint.js'), 'utf8');

type StartupResult = {
  attributes: Map<string, string>;
  style: Record<string, string>;
  storageReads: string[];
};

function runPrepaint(
  storedValue: string | null,
  options: { search?: string; storageThrows?: boolean; omitStorage?: boolean } = {},
): StartupResult {
  const attributes = new Map<string, string>();
  const style: Record<string, string> = {};
  const storageReads: string[] = [];
  const context: Record<string, unknown> = {
    window: { location: { search: options.search ?? '' } },
    document: {
      documentElement: {
        dataset: {},
        style,
        setAttribute: (name: string, value: string) => attributes.set(name, value),
      },
    },
    URLSearchParams,
    Set,
    JSON,
  };

  if (!options.omitStorage) {
    context.localStorage = {
      getItem: (key: string) => {
        storageReads.push(key);
        if (options.storageThrows) throw new Error('storage unavailable');
        return storedValue;
      },
    };
  }

  runInNewContext(prepaint, context);
  return { attributes, style, storageReads };
}

describe('theme prepaint startup contract', () => {
  it('starts with canonical fallback attributes and loads the self-hosted prepaint before React', () => {
    expect(indexHtml).toMatch(/<html lang="en" data-theme="dark" data-theme-preference="default">/);

    const prepaintIndex = indexHtml.indexOf('<script src="/theme-prepaint.js"></script>');
    const moduleIndex = indexHtml.indexOf('<script type="module" src="/src/main.tsx"></script>');
    expect(prepaintIndex).toBeGreaterThan(-1);
    expect(moduleIndex).toBeGreaterThan(prepaintIndex);
    expect(indexHtml).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  });

  it.each([
    ['origami', 'default', 'dark'],
    ['vibespace', 'default', 'dark'],
    ['warm', 'warm', 'warm'],
    ['sakura', 'default', 'dark'],
    ['monochrome', 'monochrome', 'monochrome'],
    ['light', 'monochrome', 'monochrome'],
    ['dark', 'default', 'dark'],
    ['system', 'default', 'dark'],
    ['unknown', 'default', 'dark'],
    ['constructor', 'default', 'dark'],
    ['toString', 'default', 'dark'],
    ['__proto__', 'default', 'dark'],
  ])('normalizes stored %s before React mounts', (stored, preference, documentTheme) => {
    const result = runPrepaint(JSON.stringify({ state: { theme: stored }, version: 5 }));

    expect(result.attributes.get('data-theme-preference')).toBe(preference);
    expect(result.attributes.get('data-theme')).toBe(documentTheme);
    expect(result.storageReads).toEqual(['jarvis-ui']);
  });

  it.each([
    ['missing storage', null, { omitStorage: true }],
    ['throwing storage', null, { storageThrows: true }],
    ['malformed JSON', '{broken', {}],
  ])('falls back safely for %s', (_label, stored, options) => {
    const result = runPrepaint(stored, options);

    expect(result.attributes.get('data-theme-preference')).toBe('default');
    expect(result.attributes.get('data-theme')).toBe('dark');
  });

  it('marks the pet overlay transparent before React without unsafe executable constructs', () => {
    const result = runPrepaint(null, { search: '?view=pet-overlay' });
    const petTransparencyCss = indexHtml.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';

    expect(result.attributes.get('data-vibespace-view')).toBe('pet-overlay');
    expect(result.style).toMatchObject({
      background: 'transparent',
      backgroundColor: 'transparent',
      backgroundImage: 'none',
    });
    expect(petTransparencyCss).toMatch(/html\[data-vibespace-view='pet-overlay'\] body/);
    expect(petTransparencyCss).toMatch(/html\[data-vibespace-view='pet-overlay'\] #root/);
    expect(petTransparencyCss).toMatch(/background:\s*transparent !important/);
    expect(petTransparencyCss).toMatch(/background-image:\s*none !important/);
    expect(petTransparencyCss).toMatch(/overflow:\s*hidden !important/);
    expect(prepaint).not.toMatch(/\beval\s*\(|new Function|https?:\/\/|from ['"]react['"]/);
  });
});
