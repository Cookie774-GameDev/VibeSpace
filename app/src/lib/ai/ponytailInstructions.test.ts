import { describe, expect, it } from 'vitest';
import { reasoningModeInstructions } from './reasoningControls';
import { ponytailFullInstructions } from './ponytail';
import { ponytailInstructions } from './ponytailInstructions';

describe('Ponytail Token Saver integration', () => {
  it('uses the pinned upstream full-mode builder artifact verbatim before the host policy', () => {
    expect(ponytailInstructions.startsWith(`${ponytailFullInstructions}\n\n`)).toBe(true);
    expect(ponytailInstructions.slice(ponytailFullInstructions.length + 2)).toContain(
      'Current VibeSpace /mode selection controls activation',
    );
  });

  it('injects upstream full-mode rules exclusively in Token Saver', () => {
    const saver = reasoningModeInstructions('token-saver');
    expect(saver).toContain('PONYTAIL MODE ACTIVE — level: full');
    expect(saver).toContain('Already in this codebase?');
    expect(saver).toContain('input validation at trust boundaries');
    expect(saver).toContain('| **full** |');
    expect(saver).not.toContain('| **ultra** |');
    expect(saver).not.toContain('- lite: "');
    expect(saver).not.toContain('argument-hint:');
    expect(saver).toContain('Current VibeSpace /mode selection controls activation');
    for (const mode of ['normal', 'token-final-boss'] as const) {
      expect(reasoningModeInstructions(mode)).not.toContain('PONYTAIL MODE ACTIVE');
    }
  });
});
