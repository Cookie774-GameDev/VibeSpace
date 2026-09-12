import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, 'Composer.tsx'), 'utf8');

describe('Composer live mode restriction integration', () => {
  it('routes every user-facing interaction-mode change through exact-turn safety', () => {
    expect(source).toContain('shouldCancelForLiveModeRestriction');
    expect(source).toContain('const applyInteractionMode = useCallback');
    expect(source).toContain("new CustomEvent('jarvis:cancel'");
    expect(source).toContain('detail: { messageId: cancellationKey }');
    expect(source.match(/applyInteractionMode\(nextMode\)/gu)?.length ?? 0).toBeGreaterThanOrEqual(
      3,
    );
    expect(source).toContain('applyInteractionMode(parsed.value)');
    expect(source).toContain("applyInteractionMode('ask')");
    expect(source).toContain("applyInteractionMode('plan')");
    expect(source).toContain("applyInteractionMode('agent')");
  });
});
