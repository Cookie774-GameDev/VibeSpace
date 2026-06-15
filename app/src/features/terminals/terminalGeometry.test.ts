import { describe, expect, it } from 'vitest';
import { shouldSendTerminalResize } from './terminalGeometry';

describe('shouldSendTerminalResize', () => {
  it('sends the initial terminal geometry', () => {
    expect(shouldSendTerminalResize(null, { rows: 30, cols: 100 })).toBe(true);
  });

  it('skips duplicate rows and columns', () => {
    expect(
      shouldSendTerminalResize({ rows: 30, cols: 100 }, { rows: 30, cols: 100 }),
    ).toBe(false);
  });

  it('sends changed rows or columns', () => {
    expect(
      shouldSendTerminalResize({ rows: 30, cols: 100 }, { rows: 31, cols: 100 }),
    ).toBe(true);
    expect(
      shouldSendTerminalResize({ rows: 30, cols: 100 }, { rows: 30, cols: 101 }),
    ).toBe(true);
  });
}
);
