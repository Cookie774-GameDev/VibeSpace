import { describe, expect, it } from 'vitest';
import { canRunLocalCommandWithoutModel } from './preModelBridge';

describe('pure local command readiness without model access', () => {
  it.each(['spawn 2 Claude terminals', 'open a Claude terminal', 'open settings and play music'])(
    'allows mapped command-only text: %s',
    (text) => expect(canRunLocalCommandWithoutModel(text)).toBe(true),
  );
  it.each([
    'Explain how to open settings without doing it',
    'spawn 2 Claude terminals and tell both of them to do a read audit',
    'Do not open settings; spawn 2 Claude terminals',
    'open a cursor terminal',
    'rename the button to Hello',
    '',
  ])('never mistakes preserved model text for a completed local-only turn: %s', (text) => {
    expect(canRunLocalCommandWithoutModel(text)).toBe(false);
  });
});
