import { describe, expect, it, vi } from 'vitest';
import type { CaoControlRecord } from './controlRuntime';
import {
  createProductionCaoControlActionAdapters,
  type CaoCanonicalActionCapability,
} from './productionControlActionAdapters';

const scope = { accountId: 'account-1', workspaceId: 'workspace-1', projectId: 'project-1' };
const targets = [
  { kind: 'terminal' as const, targetId: 'terminal-2', revision: 8 },
  { kind: 'chat' as const, targetId: 'chat-1', revision: 4 },
];
const record = {
  schemaVersion: 1 as const,
  revision: 3,
  ...scope,
  requestId: 'request-1',
  runId: 'run-1',
  command: {
    action: 'verify' as const,
    selectors: targets.map((target) => ({
      kind: target.kind,
      selector: target.targetId,
      by: 'id' as const,
    })),
    source: 'natural-language' as const,
  },
  targets,
  status: 'running' as const,
  leaseId: 'lease-1',
  updatedAt: 1,
} satisfies CaoControlRecord;

function harness() {
  const registry = {
    claimExact: vi.fn(),
    releaseExact: vi.fn(),
    readExact: vi.fn(async () =>
      targets.map((target) => ({
        ...target,
        ...scope,
        selected: true,
        locked: false,
        ownerLeaseId: 'lease-1',
      })),
    ),
  };
  const calls: string[] = [];
  const terminal: CaoCanonicalActionCapability = {
    execute: vi.fn(async ({ target }) => {
      calls.push(`terminal:${target.targetId}`);
      return { status: 'completed' as const, receiptId: 'receipt-terminal' };
    }),
  };
  const chat: CaoCanonicalActionCapability = {
    execute: vi.fn(async ({ target }) => {
      calls.push(`chat:${target.targetId}`);
      return { status: 'completed' as const, receiptId: 'receipt-chat' };
    }),
  };
  return { registry, terminal, chat, calls };
}

describe('production CAO control action adapters', () => {
  it('keeps a bounded aggregate identity when valid child receipts exceed 128 characters', async () => {
    const h = harness();
    const child = { execute: vi.fn(async () => ({ status: 'completed' as const, receiptId: 'r'.repeat(100) })) };
    const bundle = createProductionCaoControlActionAdapters({ registry: h.registry, capabilities: { verify: { chat: child, terminal: child } } });
    const result = await bundle.actions.verify.execute({ record, signal: new AbortController().signal });
    expect(result.status).toBe('completed');
    if (result.status === 'completed') expect(result.receiptId.length).toBeLessThanOrEqual(128);
  });
  it('revalidates exact authority and executes the selected targets in order with truthful receipts', async () => {
    const h = harness();
    const bundle = createProductionCaoControlActionAdapters({
      registry: h.registry,
      capabilities: { verify: { terminal: h.terminal, chat: h.chat } },
    });

    const result = await bundle.actions.verify!.execute({
      record,
      signal: new AbortController().signal,
    });

    expect(h.registry.readExact).toHaveBeenCalledWith({
      ...scope,
      runId: 'run-1',
      leaseId: 'lease-1',
      targets: [
        { kind: 'terminal', targetId: 'terminal-2' },
        { kind: 'chat', targetId: 'chat-1' },
      ],
    });
    expect(h.calls).toEqual(['terminal:terminal-2', 'chat:chat-1']);
    expect(result).toEqual({ status: 'completed', receiptId: 'receipt-terminal.receipt-chat' });
  });

  it('preflights every target capability so a mixed target set cannot partially dispatch', () => {
    const h = harness();
    const bundle = createProductionCaoControlActionAdapters({
      registry: h.registry,
      capabilities: { verify: { terminal: h.terminal } },
    });

    expect(() => bundle.assertAvailable('verify', targets)).toThrow(
      'cao_control_verify_chat_unavailable',
    );
    expect(h.terminal.execute).not.toHaveBeenCalled();
  });

  it('fails closed before dispatch when the durable target revision or owner drifts', async () => {
    const h = harness();
    h.registry.readExact.mockResolvedValueOnce([
      { ...targets[0], ...scope, selected: true, locked: false, ownerLeaseId: 'lease-1' },
      {
        ...targets[1],
        revision: 5,
        ...scope,
        selected: true,
        locked: false,
        ownerLeaseId: 'lease-1',
      },
    ]);
    const bundle = createProductionCaoControlActionAdapters({
      registry: h.registry,
      capabilities: { verify: { terminal: h.terminal, chat: h.chat } },
    });

    await expect(
      bundle.actions.verify!.execute({ record, signal: new AbortController().signal }),
    ).resolves.toEqual({ status: 'failed' });
    expect(h.terminal.execute).not.toHaveBeenCalled();
    expect(h.chat.execute).not.toHaveBeenCalled();
  });

  it('propagates cancellation and redacts private adapter failures', async () => {
    const h = harness();
    const failingTerminal: CaoCanonicalActionCapability = {
      execute: vi.fn(async () => {
        throw new Error('C:\\private\\token.txt secret=abc');
      }),
    };
    const bundle = createProductionCaoControlActionAdapters({
      registry: h.registry,
      capabilities: { verify: { terminal: failingTerminal, chat: h.chat } },
    });
    const failed = await bundle.actions.verify!.execute({
      record,
      signal: new AbortController().signal,
    });
    expect(failed).toEqual({ status: 'failed' });
    expect(JSON.stringify(failed)).not.toContain('private');

    const controller = new AbortController();
    controller.abort();
    await expect(
      bundle.actions.verify!.execute({ record, signal: controller.signal }),
    ).resolves.toEqual({
      status: 'cancelled',
    });
  });
});
