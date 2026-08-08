import { describe, expect, it } from 'vitest';
import { moveProviderToIndex } from './taskbarUsageStore';

describe('taskbar usage provider drag ordering', () => {
  it('moves a dragged provider to the requested bounded index', () => {
    expect(
      moveProviderToIndex(['openai', 'codex'], ['openai', 'codex', 'claude'], 'claude', 0),
    ).toEqual(['claude', 'openai', 'codex']);
    expect(moveProviderToIndex([], ['openai', 'codex'], 'openai', 99)).toEqual(['codex', 'openai']);
  });
});
