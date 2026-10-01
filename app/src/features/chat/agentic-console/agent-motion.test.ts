import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const stylesheet = readFileSync(
  resolve(process.cwd(), 'src/features/chat/agentic-console/agent-motion.css'),
  'utf8',
);

describe('agent activity motion visual contract', () => {
  it('uses the reference-size canvas and scales only the inner canvas in compact layouts', () => {
    expect(stylesheet).toContain('.agent-motion-slot');
    expect(stylesheet).toMatch(/--agent-motion-canvas-width:\s*82px/);
    expect(stylesheet).toMatch(/--agent-motion-canvas-height:\s*54px/);
    expect(stylesheet).toMatch(
      /\.agent-motion-slot\[data-agent-motion-size='compact'\][\s\S]*?--agent-motion-scale:\s*0\.48/,
    );
  });

  it.each(['default', 'monochrome', 'jarvis', 'warm'])(
    'defines an intentional %s release-theme palette',
    (theme) => {
      expect(stylesheet).toContain(`html[data-theme='${theme}'] .agent-motion-slot`);
    },
  );

  it('preserves hidden-window pausing and reduced-motion accessibility', () => {
    expect(stylesheet).toContain("html[data-app-visibility='hidden'] .agent-motion");
    expect(stylesheet).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
