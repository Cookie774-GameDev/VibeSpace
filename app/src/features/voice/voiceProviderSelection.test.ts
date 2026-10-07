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

  it('preserves the visible Luna route instead of a different voice default when no Main override exists', () => {
    const luna = route('openai', 'openai/gpt-6-luna', OPENCODE_CLI_CONNECTION);
    const automatic = route('openai', 'codex-auto-review', CODEX_CLI_CONNECTION);
    expect(resolveVoiceProviderSelection({
      provider: 'codex', options: [automatic, luna],
      preferredSelection: selectionFromOption('openai', luna.modelId, OPENCODE_CLI_CONNECTION),
      preservePreferredRoute: true,
    })).toMatchObject({
      provider: 'opencode', connectionId: OPENCODE_CLI_CONNECTION.id,
      selection: { providerId: 'openai', modelId: luna.modelId, connectionId: OPENCODE_CLI_CONNECTION.id },
    });
  });

  it('does not substitute a default when the visible route becomes unavailable', () => {
    const luna = route('openai', 'openai/gpt-6-luna', OPENCODE_CLI_CONNECTION, false);
    expect(() => resolveVoiceProviderSelection({
      provider: 'codex', options: [codex, luna],
      preferredSelection: selectionFromOption('openai', luna.modelId, OPENCODE_CLI_CONNECTION),
      preservePreferredRoute: true,
    })).toThrow(VoiceProviderUnavailableError);
  });

  it('fails closed when the exact provider has no available connected route', () => {
    expect(() =>
      resolveVoiceProviderSelection({
        provider: 'codex',
        options: [route('openai', 'gpt-5.6-sol', CODEX_CLI_CONNECTION, false), openCode],
      }),
    ).toThrow(VoiceProviderUnavailableError);
  });

  it.each(['missing', 'unavailable'])(
    'does not replace an explicit %s saved model in the requested harness',
    (state) => {
      const saved = route('openai', 'selected-model', CODEX_CLI_CONNECTION, false);
      expect(() =>
        resolveVoiceProviderSelection({
          provider: 'codex',
          options: state === 'missing' ? [codex] : [codex, saved],
          preferredSelection: selectionFromOption('openai', saved.modelId, CODEX_CLI_CONNECTION),
        }),
      ).toThrow(VoiceProviderUnavailableError);
    },
  );

  it('does not replace an explicit non-harness selection with a CLI default', () => {
    expect(() =>
      resolveVoiceProviderSelection({
        provider: 'codex',
        options: [codex],
        preferredSelection: selectionFromOption('groq', 'selected-cloud-model'),
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

describe('negated voice provider directives', () => {
  it.each([
    'Do not use OpenCode for the main agent. Inspect this project.',
    "Don't run Codex as the worker. Inspect this project.",
    'Never switch to OpenCode for main: inspect this project.',
    'Do not use OpenCode for main and Codex for worker. Inspect this project.',
  ])('keeps negated provider directives intact for the current route: %s', (text) => {
    expect(parseVoiceProviderOverrides(text)).toBeNull();
  });
});

describe('quoted and mixed voice provider directives', () => {
  it.each([
    'Explain "use OpenCode for main" without changing my route.',
    "Explain 'use Codex as worker' without changing my route.",
    'Say “use OpenCode for main” verbatim.',
    'Explain `use Codex for worker`.',
    'Explain "use OpenCode for main',
    'Use Codex for main, but do not use OpenCode for worker. Inspect this project.',
  ])('does not turn quoted or mixed negated text into a provider override: %s', (text) => {
    expect(parseVoiceProviderOverrides(text)).toBeNull();
  });

  it('still recognizes a positive directive outside a quoted example and preserves the example', () => {
    expect(
      parseVoiceProviderOverrides(
        'Quote "use OpenCode for main"; use Codex for worker: inspect this project.',
      ),
    ).toEqual({
      providers: { worker: 'codex' },
      taskText: 'Quote "use OpenCode for main"; : inspect this project.',
      saveAsDefault: false,
    });
  });
});

it('does not persist a positive route override because a save instruction was only quoted', () => {
  expect(
    parseVoiceProviderOverrides(
      'Use Codex for main. Explain "save these providers as my defaults".',
    ),
  ).toEqual({
    providers: { main: 'codex' },
    taskText: 'Explain "save these providers as my defaults".',
    saveAsDefault: false,
  });
});

describe('negated role-first voice provider directives', () => {
  it.each([
    'Do not set the main provider to OpenCode. Inspect the project.',
    "Don't make the worker provider: Codex. Explain only.",
    'Never set main: OpenCode. Explain only.',
  ])('preserves a negated setting directive on the current route: %s', (text) => {
    expect(parseVoiceProviderOverrides(text)).toBeNull();
  });

  it('preserves the existing positive role-first setting form', () => {
    expect(
      parseVoiceProviderOverrides('Set the main provider to OpenCode. Inspect the project.'),
    ).toMatchObject({
      providers: { main: 'opencode' },
      saveAsDefault: false,
    });
  });
});

describe('smart apostrophes inside quoted voice provider examples', () => {
  it.each([
    'Explain ‘we don’t usually use OpenCode for main’ verbatim.',
    'Explain ‘the worker’s instructions say use Codex for worker’ verbatim.',
  ])('keeps an internal smart apostrophe inside the quoted example: %s', (text) => {
    expect(parseVoiceProviderOverrides(text)).toBeNull();
  });

  it('still accepts a positive command after the real closing quote', () => {
    const result = parseVoiceProviderOverrides(
      'Explain ‘the worker’s instructions’ then use OpenCode for main: inspect this project.',
    );
    expect(result).toMatchObject({ providers: { main: 'opencode' }, saveAsDefault: false });
    expect(result?.taskText).toContain('‘the worker’s instructions’');
  });
});
