import { expect, it } from 'vitest';
import { buildLocalActionContext } from './modelContext';
import type { LocalBridgeExecution } from './types';

it('never describes queued terminal launches as verified ready and never exposes message payloads', () => {
  const execution: LocalBridgeExecution = {
    detected: {
      id: 'terminal.open',
      confidence: 0.99,
      source: 'open two Claude terminals',
      sourceStart: 0,
      sourceEnd: 25,
      slots: { provider: 'claude', count: 2, payload: 'DO_NOT_LEAK_PRIVATE_PAYLOAD' },
      path: 'local-frame',
    },
    command: { kind: 'open-agent-cli', provider: 'claude', count: 2 },
    correlationId: 'private-correlation',
    receipt: {
      commandId: 'terminal.open',
      correlationId: 'private-correlation',
      status: 'queued',
      acceptedAtMs: 1,
      targetIds: ['private-target'],
    },
  };
  const context = buildLocalActionContext([execution])!;
  expect(context).toContain('count=2');
  expect(context).toContain('status=queued');
  expect(context).toContain('not proof of readiness');
  expect(context).toContain('verify live targets');
  expect(context).not.toContain('DO_NOT_LEAK_PRIVATE_PAYLOAD');
  expect(context).not.toContain('private-correlation');
  expect(context).not.toContain('private-target');
  expect(context.length).toBeLessThanOrEqual(800);
});
