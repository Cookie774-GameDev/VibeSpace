import { afterEach, describe, expect, it } from 'vitest';
import type { ExpectedTerminalProcessBinding } from '@/features/terminals/terminalRefs';
import {
  bindCaoTerminalExecutionIdentity,
  invalidateCaoTerminalExecutionIdentity,
  observeCaoTerminalOpenCodeEvent,
  invalidateCaoTerminalExecutionIdentityOnExit,
  getCaoTerminalExecutionIdentityRevision,
  readCaoTerminalExecutionIdentity,
  resetCaoTerminalExecutionIdentityForTests,
  subscribeCaoTerminalExecutionIdentity,
  type CaoTerminalExecutionBinding,
} from './terminalExecutionIdentity';

const process: ExpectedTerminalProcessBinding = {
  projectId: 'project-a',
  processInstanceId: 'process-a',
  pid: 42,
  processStartedAt: 1_780_000_000_000,
  runtimeGeneration: 'runtime-a',
};

function binding(
  overrides: Partial<CaoTerminalExecutionBinding> = {},
): CaoTerminalExecutionBinding {
  return {
    accountId: 'account-a',
    projectId: 'project-a',
    paneId: 'pane-a',
    sessionId: 'session-a',
    process,
    ...overrides,
  };
}

function stepStart(overrides: Record<string, unknown> = {}) {
  return {
    type: 'step_start',
    sessionID: 'session-a',
    part: {
      type: 'step-start',
      sessionID: 'session-a',
      modelID: 'openai/gpt-5.6-luna',
      variant: 'high',
      ...overrides,
    },
  };
}

afterEach(() => {
  resetCaoTerminalExecutionIdentityForTests();
});

describe('pane-bound OpenCode terminal identity', () => {
  it('records exact provider, model, variant, and PTY process binding from a step event', () => {
    const receipt = observeCaoTerminalOpenCodeEvent(binding(), stepStart(), 100);

    expect(receipt).toMatchObject({
      source: 'opencode-cli-event',
      observedAt: 100,
      observedProviderId: 'openai',
      observedModelId: 'gpt-5.6-luna',
      variant: 'high',
      identity: {
        backend: 'opencode',
        providerId: 'opencode',
        connectionId: 'opencode-cli',
        modelId: 'openai/gpt-5.6-luna',
        reasoningEffort: 'high',
      },
      binding: { paneId: 'pane-a', sessionId: 'session-a', process },
    });
    expect(readCaoTerminalExecutionIdentity(binding())).toBe(receipt);
  });

  it('accepts the existing OpenCode assistant session event shape', () => {
    const receipt = observeCaoTerminalOpenCodeEvent(
      binding(),
      {
        type: 'message.updated',
        properties: {
          sessionID: 'session-a',
          info: {
            role: 'assistant',
            providerID: 'anthropic',
            modelID: 'claude-sonnet',
            variant: 'balanced',
          },
        },
      },
      200,
    );

    expect(receipt?.identity.modelId).toBe('anthropic/claude-sonnet');
    expect(receipt?.variant).toBe('balanced');
  });

  it('preserves an authoritative OpenRouter namespace inside modelID', () => {
    const receipt = observeCaoTerminalOpenCodeEvent(
      binding(),
      {
        type: 'message.updated',
        properties: {
          sessionID: 'session-a',
          info: {
            role: 'assistant',
            providerID: 'openrouter',
            modelID: 'deepseek/deepseek-v4-flash',
            variant: 'high',
          },
        },
      },
      250,
    );

    expect(receipt).toMatchObject({
      observedProviderId: 'openrouter',
      observedModelId: 'deepseek/deepseek-v4-flash',
      identity: { modelId: 'openrouter/deepseek/deepseek-v4-flash' },
    });
  });

  it('keeps a conflicting-looking model namespace under the authoritative provider', () => {
    const receipt = observeCaoTerminalOpenCodeEvent(
      binding(),
      {
        type: 'message.updated',
        properties: {
          sessionID: 'session-a',
          info: {
            role: 'assistant',
            providerID: 'openrouter',
            modelID: 'anthropic/claude-sonnet',
            variant: 'balanced',
          },
        },
      },
      275,
    );

    expect(receipt?.observedProviderId).toBe('openrouter');
    expect(receipt?.observedModelId).toBe('anthropic/claude-sonnet');
  });

  it('never treats terminal prose, startup command, or an unrelated event as identity evidence', () => {
    expect(
      observeCaoTerminalOpenCodeEvent(binding(), {
        type: 'text',
        sessionID: 'session-a',
        part: { text: 'openai/gpt-5.6-luna high' },
      }),
    ).toBeUndefined();
    expect(
      observeCaoTerminalOpenCodeEvent(binding(), {
        type: 'step_start',
        sessionID: 'other-session',
        part: { modelID: 'openai/gpt-5.6-luna', variant: 'high' },
      }),
    ).toBeUndefined();
    expect(readCaoTerminalExecutionIdentity(binding())).toBeUndefined();
  });

  it('fails closed when the real event omits an exact provider, model, or variant', () => {
    expect(
      observeCaoTerminalOpenCodeEvent(binding(), stepStart({ variant: undefined })),
    ).toBeUndefined();
    expect(
      observeCaoTerminalOpenCodeEvent(
        binding(),
        stepStart({ modelID: 'gpt-5.6-luna', providerID: undefined }),
      ),
    ).toBeUndefined();
    expect(
      observeCaoTerminalOpenCodeEvent(
        binding(),
        stepStart({ modelID: 'openai/gpt-5.6-luna#high', variant: 'low' }),
      ),
    ).toBeUndefined();
  });

  it('retires a prior receipt when the pane is attached to a new PTY process or session', () => {
    const firstBinding = binding();
    const first = observeCaoTerminalOpenCodeEvent(firstBinding, stepStart(), 100);
    expect(first).toBeDefined();

    const replacementProcess = { ...process, processInstanceId: 'process-b', pid: 43 };
    const replacementBinding = binding({
      process: replacementProcess,
      sessionId: 'session-b',
    });
    expect(bindCaoTerminalExecutionIdentity(replacementBinding)).toBe(true);
    expect(readCaoTerminalExecutionIdentity(firstBinding)).toBeUndefined();
    expect(readCaoTerminalExecutionIdentity(replacementBinding)).toBeUndefined();

    const replacement = observeCaoTerminalOpenCodeEvent(
      replacementBinding,
      {
        ...stepStart(),
        sessionID: 'session-b',
        part: { ...stepStart().part, sessionID: 'session-b' },
      },
      300,
    );
    expect(replacement?.binding.sessionId).toBe('session-b');
    expect(replacement?.binding.process.processInstanceId).toBe('process-b');
  });

  it('requires the exact process generation when reading or invalidating a receipt', () => {
    const original = binding();
    observeCaoTerminalOpenCodeEvent(original, stepStart(), 100);
    const replaced = binding({ process: { ...process, runtimeGeneration: 'runtime-b' } });

    expect(readCaoTerminalExecutionIdentity(replaced)).toBeUndefined();
    invalidateCaoTerminalExecutionIdentity(replaced);
    expect(readCaoTerminalExecutionIdentity(original)).toBeDefined();

    invalidateCaoTerminalExecutionIdentity(original);
    expect(readCaoTerminalExecutionIdentity(original)).toBeUndefined();
  });

  it('invalidates the exact registry receipt when the native PTY exits', () => {
    const original = binding();
    observeCaoTerminalOpenCodeEvent(original, stepStart(), 100);

    invalidateCaoTerminalExecutionIdentityOnExit({
      sessionId: original.sessionId,
      processInstanceId: original.process.processInstanceId,
      pid: original.process.pid,
      processStartedAt: original.process.processStartedAt,
      runtimeGeneration: original.process.runtimeGeneration,
    });

    expect(readCaoTerminalExecutionIdentity(original)).toBeUndefined();
  });

  it('does not invalidate a receipt for a stale or foreign native exit', () => {
    const original = binding();
    observeCaoTerminalOpenCodeEvent(original, stepStart(), 100);

    invalidateCaoTerminalExecutionIdentityOnExit({
      sessionId: original.sessionId,
      processInstanceId: 'foreign-process',
      pid: original.process.pid,
      processStartedAt: original.process.processStartedAt,
      runtimeGeneration: original.process.runtimeGeneration,
    });

    expect(readCaoTerminalExecutionIdentity(original)).toBeDefined();
  });

  it('publishes a revision notification for bind, receipt, and native exit changes', () => {
    const revisions: number[] = [];
    const unsubscribe = subscribeCaoTerminalExecutionIdentity(() => {
      revisions.push(getCaoTerminalExecutionIdentityRevision());
    });
    const original = binding();
    observeCaoTerminalOpenCodeEvent(original, stepStart(), 100);
    invalidateCaoTerminalExecutionIdentityOnExit({
      sessionId: original.sessionId,
      processInstanceId: original.process.processInstanceId,
      pid: original.process.pid,
      processStartedAt: original.process.processStartedAt,
      runtimeGeneration: original.process.runtimeGeneration,
    });
    unsubscribe();

    expect(revisions.length).toBeGreaterThanOrEqual(3);
    expect(revisions).toEqual([...revisions].sort((left, right) => left - right));
    expect(getCaoTerminalExecutionIdentityRevision()).toBe(revisions.at(-1));
  });
});
