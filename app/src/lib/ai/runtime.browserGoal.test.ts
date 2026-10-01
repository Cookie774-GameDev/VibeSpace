import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, 'runtime.ts'), 'utf8');

describe('AI runtime Browser Goal activation seam', () => {
  it('wraps the canonical builtin dispatcher with durable Browser Goal launch', () => {
    const hostMethod = source.indexOf('async executeRegisteredAction(dispatchInput)');
    const loadRun = source.indexOf('journal.getRun(', hostMethod);
    const launch = source.indexOf('browserGoalLaunchRuntime.executeRegisteredAction(', hostMethod);
    const dispatch = source.indexOf('builtinActionDispatcher(dispatchInput)', launch);

    expect(hostMethod).toBeGreaterThan(0);
    expect(loadRun).toBeGreaterThan(hostMethod);
    expect(launch).toBeGreaterThan(loadRun);
    expect(dispatch).toBeGreaterThan(launch);
  });

  it('does not add a browser-specific chat mode or model switch', () => {
    expect(source).not.toMatch(/browserChatMode|setBrowserModel|switchBrowserModel/);
  });
});
