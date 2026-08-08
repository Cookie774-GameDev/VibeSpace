import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../../styles/warm-theme.css'), 'utf8');

describe('Warm Schedule glass treatment', () => {
  it('keeps the glass treatment scoped to Warm Schedule semantic surfaces', () => {
    expect(css).toMatch(
      /html\[data-theme='warm'\][\s\S]*?\[data-monochrome-route='schedule'\][\s\S]*?\[data-monochrome-surface='schedule-timeline'\][\s\S]*?backdrop-filter:\s*blur\(18px\)\s+saturate\(1\.12\)/u,
    );
    expect(css).toMatch(
      /\[data-monochrome-surface='schedule-editor'\][\s\S]*?background:\s*rgb\(255 247 236 \/ 0\.56\)/u,
    );
    expect(css).not.toContain("html[data-theme='monochrome'] [data-warm-surface");
    expect(css).not.toContain("html[data-theme='sakura'] [data-warm-surface");
  });
});
