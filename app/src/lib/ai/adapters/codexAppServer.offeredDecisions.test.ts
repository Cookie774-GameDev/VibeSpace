import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/diagnostics/appActivityLog', () => ({
  appActivityLog: { record: vi.fn() },
}));
vi.mock('../publicToolDetails', () => ({
  publicToolDetails: vi.fn(() => ({})),
  publicToolOutput: vi.fn(() => undefined),
}));

import { normalizeCodexAppServerMessage } from './codexAppServer';

describe('Codex offered approval decisions', () => {
  it('preserves an explicit empty choice set instead of turning it into default UI options', () => {
    const result = normalizeCodexAppServerMessage(
      {
        id: 'approval_empty_choices',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-1',
          availableDecisions: [],
        },
      },
      {
        scope: {
          activeGeneration: 1,
          messageGeneration: 1,
          threadId: 'thread-1',
          turnId: 'turn-1',
        },
      },
    );
    expect(result.controls[0]).toMatchObject({ display: { availableDecisions: [] } });
  });
});
