import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('Sakura Dusk restoration source contract', () => {
  const css = readSource('src/styles/sakura-theme.css');
  const scene = readSource('src/features/appearance/sakura/sakura-scene.svg');

  it('keeps the exact owner-approved palette and material tiers scoped to Sakura', () => {
    for (const color of [
      '#140e30',
      '#232051',
      '#2f2b71',
      '#4e518a',
      '#a082aa',
      '#916285',
      '#eeabb7',
      '#ef6f88',
      '#f5cec8',
      '#fff7f2',
      '#ffd978',
      '#9ed0b8',
    ]) {
      expect(css.toLowerCase()).toContain(color);
    }
    expect(css).toContain('--sakura-panel-alpha: 0.76');
    expect(css).toContain('--sakura-panel-alpha-strong: 0.91');
    expect(css).not.toContain(':root');
    expect(css).not.toMatch(/html\[data-theme='(?!sakura)[^']+'\][^{]*\[data-sakura-/u);
  });

  it('uses the actual supplied 1600x1000 pavilion, lantern, and blossom composition', () => {
    expect(scene).toContain('viewBox="0 0 1600 1000"');
    expect(scene).toContain('transform="translate(132 485)"');
    expect(scene).toContain('transform="translate(1368 635)"');
    expect(scene).toContain('<!-- branch and blossoms -->');
  });

  it('keeps one transform-only petal animation with component density and reduced-motion limits', () => {
    expect(css.match(/@keyframes sakura-petal-drift/gu)).toHaveLength(1);
    expect(css).toMatch(
      /animation:\s*sakura-petal-drift\s+calc\(var\(--sakura-petal-duration\) \* var\(--sakura-petal-speed-multiplier\)\)/u,
    );
    expect(css).not.toMatch(/\[data-sakura-speed='(?:slow|normal|fast)'\]/u);
    expect(css).not.toMatch(/\[data-sakura-petal\]:nth-child/u);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\[data-sakura-petals\]/u);
  });

  it('protects Sakura Kanban heading contrast over the bright dusk band', () => {
    expect(css).toMatch(/\[data-sakura-route='kanban'\]\s*>\s*header\s*>\s*div:first-child/u);
    expect(css).toMatch(/--sakura-kanban-heading-glass:/u);
  });
});

describe('MonoChrome surgical readability contract', () => {
  const css = readSource('src/styles/monochrome-theme.css');

  it('raises legibility without changing the existing palette or compact geometry', () => {
    expect(css).toMatch(/body \{[\s\S]*font-size: 14px;[\s\S]*line-height: 1\.5;/u);
    expect(css).toMatch(/\.text-metadata[\s\S]*font-size: 12px;[\s\S]*line-height: 1\.45;/u);
    expect(css).toMatch(
      /\[data-terminal-drop='pane'\] \.xterm[\s\S]*font-size: max\(13px, 1em\);/u,
    );
    expect(css).toContain('--monochrome-top-bar-height: 36px');
    expect(css).not.toMatch(/#(?:eeabb7|ef6f88|f5cec8|ffd978)/iu);
  });
});
