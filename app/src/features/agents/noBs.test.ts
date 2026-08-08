import { describe, expect, it } from 'vitest';
import { NO_BS_PROMPT_SECTION, hasNoBsPromptSection, setNoBsPromptSection } from './noBs';

describe('NO BS agent prompt section', () => {
  it('appends the canonical section to the end of the prompt', () => {
    const result = setNoBsPromptSection('Keep the user safe.', true);

    expect(result).toBe(`Keep the user safe.\n\n${NO_BS_PROMPT_SECTION}`);
    expect(result.endsWith(NO_BS_PROMPT_SECTION)).toBe(true);
    expect(hasNoBsPromptSection(result)).toBe(true);
  });

  it('is idempotent and moves an existing section back to the end', () => {
    const once = setNoBsPromptSection('Base prompt.', true);
    const moved = `${once}\n\nLater instructions.`;
    const result = setNoBsPromptSection(moved, true);

    expect(result).toBe(`Base prompt.\n\nLater instructions.\n\n${NO_BS_PROMPT_SECTION}`);
    expect(result.match(/vibespace:no-bs:start/g)).toHaveLength(1);
  });

  it('removes only the canonical section when disabled', () => {
    const original = 'First paragraph.\n\nSecond paragraph.';
    const enabled = setNoBsPromptSection(original, true);

    expect(setNoBsPromptSection(enabled, false)).toBe(original);
    expect(hasNoBsPromptSection(setNoBsPromptSection(enabled, false))).toBe(false);
  });
});
