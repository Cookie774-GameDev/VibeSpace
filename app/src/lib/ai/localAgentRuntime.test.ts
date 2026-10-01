import { describe, expect, it } from 'vitest';
import {
  LOCAL_AGENT_PREFERENCES_EVENT,
  LocalCloudEscalationRequiredError,
  localAgentSystemInstruction,
  localOllamaRequestPolicy,
  planLocalCloudEscalation,
  readLocalAgentPreferences,
  writeLocalAgentPreferences,
} from './localAgentRuntime';

function memoryStorage(initial?: string) {
  let value = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
    value: () => value,
  };
}

describe('local agent runtime preferences', () => {
  it('fails closed to fast mode with cloud escalation disabled', () => {
    expect(readLocalAgentPreferences(memoryStorage())).toEqual({
      mode: 'fast',
      cloudEscalationEnabled: false,
    });
    expect(
      readLocalAgentPreferences(memoryStorage('{"mode":"deep","cloudEscalationEnabled":"yes"}')),
    ).toEqual({
      mode: 'fast',
      cloudEscalationEnabled: false,
    });
  });

  it('persists only the closed preference shape and emits one same-window change', () => {
    const storage = memoryStorage();
    const events: unknown[] = [];
    const listener = (event: Event) => events.push((event as CustomEvent).detail);
    window.addEventListener(LOCAL_AGENT_PREFERENCES_EVENT, listener);
    try {
      writeLocalAgentPreferences({ mode: 'deep', cloudEscalationEnabled: true }, storage);
    } finally {
      window.removeEventListener(LOCAL_AGENT_PREFERENCES_EVENT, listener);
    }

    expect(storage.value()).toBe('{"version":1,"mode":"deep","cloudEscalationEnabled":true}');
    expect(events).toEqual([{ mode: 'deep', cloudEscalationEnabled: true }]);
  });

  it('maps fast and deep modes to bounded Ollama behavior', () => {
    expect(localOllamaRequestPolicy('fast')).toEqual({
      think: false,
      numPredict: 512,
      requiresVerification: false,
    });
    expect(localOllamaRequestPolicy('deep')).toEqual({
      think: true,
      numPredict: 2_048,
      requiresVerification: true,
    });
  });

  it('adds the Planner → Executor → Verifier contract only to Deep work', () => {
    expect(localAgentSystemInstruction('fast')).toContain('Answer directly');
    expect(localAgentSystemInstruction('fast')).not.toContain('Planner → Executor → Verifier');
    expect(localAgentSystemInstruction('deep')).toContain('Planner → Executor → Verifier');
    expect(localAgentSystemInstruction('deep')).toContain('existing approval');
    expect(localAgentSystemInstruction('deep')).toContain('verifiable evidence');
  });
});

describe('local cloud escalation policy', () => {
  const input = {
    offlineMode: false,
    enabled: true,
    failure: 'inference_failed' as const,
    providerId: 'google',
    modelId: 'gemini-3.5-flash',
    data: {
      messageChars: 120,
      contextChars: 300,
      categories: ['prompt', 'local excerpts'],
    },
  };

  it('refuses every escalation in Fully Local Chat', () => {
    expect(planLocalCloudEscalation({ ...input, offlineMode: true })).toEqual({
      status: 'refused',
      reason: 'fully_local',
    });
  });

  it('does not offer escalation until the user opts in', () => {
    expect(planLocalCloudEscalation({ ...input, enabled: false })).toEqual({
      status: 'not_offered',
      reason: 'disabled',
    });
  });

  it('returns a bounded disclosure without including prompt or excerpt contents', () => {
    const proposal = planLocalCloudEscalation(input);

    expect(proposal).toEqual({
      status: 'approval_required',
      failure: 'inference_failed',
      providerId: 'google',
      modelId: 'gemini-3.5-flash',
      data: {
        messageChars: 120,
        contextChars: 300,
        categories: ['prompt', 'local excerpts'],
      },
    });
    expect(JSON.stringify(proposal)).not.toContain('secret prompt');
    expect(Object.isFrozen(proposal)).toBe(true);
    if (proposal.status !== 'approval_required') throw new Error('Expected proposal');
    expect(Object.isFrozen(proposal.data)).toBe(true);
    expect(Object.isFrozen(proposal.data.categories)).toBe(true);
  });

  it('wraps only an approval-required disclosure in the typed router error', () => {
    const proposal = planLocalCloudEscalation(input);
    if (proposal.status !== 'approval_required') throw new Error('Expected proposal');

    const error = new LocalCloudEscalationRequiredError(proposal);

    expect(error.name).toBe('LocalCloudEscalationRequiredError');
    expect(error.message).toContain('google');
    expect(error.message).toContain('gemini-3.5-flash');
    expect(error.proposal).toBe(proposal);
  });
});
