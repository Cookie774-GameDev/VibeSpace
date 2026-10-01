import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceRoot = resolve(basename(process.cwd()) === 'app' ? 'src' : 'app/src');
const css = readFileSync(resolve(sourceRoot, 'styles/sakura-theme.css'), 'utf8');
const scene = readFileSync(
  resolve(sourceRoot, 'features/appearance/sakura/sakura-scene.svg'),
  'utf8',
);

describe('Sakura atmosphere parity', () => {
  it('uses the approved layered source composition and dusk gradients', () => {
    expect(scene).toContain('viewBox="0 0 1600 1000"');
    expect(scene).toMatch(
      /<linearGradient id="sky"[\s\S]*?#f8d3c9[\s\S]*?#e89caf[\s\S]*?#a283b5[\s\S]*?#4e518a[\s\S]*?#140e30/u,
    );
    expect(scene).toContain('transform="translate(132 485)"');
    expect(scene).toContain('transform="translate(1368 635)"');
    expect(scene).toContain('<!-- branch and blossoms -->');
  });

  it('locks the translucent ink-glass and quiet scenic veil from the approved reference', () => {
    expect(css).toMatch(/--sakura-panel-alpha:\s*0\.76;/u);
    expect(css).toMatch(/--sakura-blur:\s*14px;/u);
    expect(css).toMatch(/backdrop-filter:\s*blur\(var\(--sakura-blur\)\) saturate\(1\.15\);/u);
    expect(css).toMatch(
      /html\[data-theme='sakura'\] \[data-sakura-backdrop\]::before\s*\{[\s\S]*?linear-gradient\([\s\S]*?var\(--sakura-night\)[\s\S]*?\);/u,
    );
    expect(css).toMatch(
      /\[data-sakura-scene\]\s*\{[\s\S]*?filter:\s*saturate\(0\.94\) contrast\(1\.02\);/u,
    );
  });

  it('keeps petals sparse while matching the cel-shaped gradient and slow tumble', () => {
    expect(css).toMatch(
      /\[data-sakura-petal\]\s*\{[\s\S]*?height:\s*calc\(var\(--sakura-petal-size\) \* 0\.58\);/u,
    );
    expect(css).toMatch(
      /linear-gradient\(\s*135deg,\s*var\(--sakura-ivory\),\s*var\(--sakura-pink\) 58%,\s*var\(--sakura-orchid\)\s*\)/u,
    );
    expect(css).toMatch(/45%\s*\{[\s\S]*?rotate\(230deg\);/u);
    expect(css).toMatch(/100%\s*\{[\s\S]*?rotate\(520deg\);/u);
  });
});
