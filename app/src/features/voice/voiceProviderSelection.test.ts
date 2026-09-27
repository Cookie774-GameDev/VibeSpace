import { describe, expect, it } from 'vitest';
import { CODEX_CLI_CONNECTION, OPENCODE_CLI_CONNECTION } from '@/lib/ai/adapters/catalog';
import { selectionFromOption } from '@/lib/ai/modelSelection';
import type { ModelPickerOption } from '@/lib/ai/useAccessibleChatModels';
import {
  parseVoiceProviderOverrides,
  resolveVoiceProviderSelection,
  VoiceProviderUnavailableError,
} from './voiceProviderSelection';

function route(
  provider: ModelPickerOption['provider'],
  modelId: string,
  connection: typeof CODEX_CLI_CONNECTION | typeof OPENCODE_CLI_CONNECTION,
  available = true,
): ModelPickerOption {
  return {
    id: `${connection.id}:${modelId}`,
    provider,
    modelId,
    label: modelId,
    connection,
    connectionId: connection.id,
    available,
  };
}

describe('resolveVoiceProviderSelection', () => {
  const codex = route('openai', 'gpt-5.6-sol', CODEX_CLI_CONNECTION);
  const openCode = route('openai', 'openai/gpt-5.6-sol', OPENCODE_CLI_CONNECTION);

  it('resolves the requested provider from an available exact connected route', () => {
    expect(
      resolveVoiceProviderSelection({ provider: 'opencode', options: [codex, openCode] }),
    ).toMatchObject({
      provider: 'opencode',
      connectionId: OPENCODE_CLI_CONNECTION.id,
      routeId: openCode.id,
      modelLabel: 'OpenCode · openai/gpt-5.6-sol',
      selection: {
        mode: 'single',
        providerId: 'openai',
        modelId: 'openai/gpt-5.6-sol',
        connectionId: OPENCODE_CLI_CONNECTION.id,
      },
    });
  });

  it('keeps Codex and OpenCode choices independent and prefers an available saved route only within its provider', () => {
    const preferred = route('openai', 'gpt-5.6-sol-fast', CODEX_CLI_CONNECTION);
    expect(
      resolveVoiceProviderSelection({
        provider: 'codex',
        options: [codex, preferred, openCode],
        preferredSelection: selectionFromOption('openai', preferred.modelId, CODEX_CLI_CONNECTION),
      }),
    ).toMatchObject({ routeId: preferred.id, provider: 'codex' });
    expect(
      resolveVoiceProviderSelection({
        provider: 'opencode',
        options: [codex, preferred, openCode],
        preferredSelection: selectionFromOption('openai', preferred.modelId, CODEX_CLI_CONNECTION),
      }),
    ).toMatchObject({ routeId: openCode.id, provider: 'opencode' });
  });

  it('fails closed when the exact provider has no available connected route', () => {
    expect(() =>
      resolveVoiceProviderSelection({
        provider: 'codex',
        options: [route('openai', 'gpt-5.6-sol', CODEX_CLI_CONNECTION, false), openCode],
      }),
    ).toThrow(VoiceProviderUnavailableError);
  });
});

describe('parseVoiceProviderOverrides', () => {
  it('extracts independent main and worker overrides and leaves the actual task text', () => {
    expect(
      parseVoiceProviderOverrides(
        'Use OpenCode for the main agent and Codex for the worker: inspect the selected project.',
      ),
    ).toEqual({
      providers: { main: 'opencode', worker: 'codex' },
      taskText: 'inspect the selected project.',
      saveAsDefault: false,
    });
  });

  it('accepts role-first directives and records only explicit save intent', () => {
    expect(
      parseVoiceProviderOverrides(
        'Main agent: Codex. Worker: OpenCode. Save these providers as my defaults. Review this task.',
      ),
    ).toEqual({
      providers: { main: 'codex', worker: 'opencode' },
      taskText: 'Review this task.',
      saveAsDefault: true,
    });
  });

  it('ignores unscoped provider mentions and negated save requests', () => {
    expect(parseVoiceProviderOverrides('Maybe OpenCode can review the worker task.')).toBeNull();
    expect(
      parseVoiceProviderOverrides('Use OpenCode for the worker, but do not save it as default.'),
    ).toEqual({
      providers: { worker: 'opencode' },
      taskText: 'but do not save it as default.',
      saveAsDefault: false,
    });
  });
});
