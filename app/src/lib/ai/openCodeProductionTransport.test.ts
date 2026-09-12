import { describe, expect, it } from 'vitest';
import {
  assertCatalogExecutionAllowed,
  assertProductionOpenCodeSend,
  assertProductionSendDoesNotUseOpenCodeRun,
  assertSupportedOpenCodeEffort,
  catalogSourceFromLiveProviders,
  isDiagnosticOpenCodeRun,
  isSafeAbsoluteWorkingDirectory,
  liveVariantsForSelection,
  resolveProductionWorkingDirectory,
  shouldDispatchOpenCodeThroughHarness,
} from './openCodeProductionTransport';
import { buildOpenCodeInvocation } from './adapters/opencode';

describe('OpenCode production transport contract', () => {
  it('refuses a warm production send that would invoke opencode run', () => {
    const diagnostic = buildOpenCodeInvocation({ prompt: 'hello', modelId: 'openai/gpt-5' });
    expect(isDiagnosticOpenCodeRun(diagnostic.args)).toBe(true);
    expect(() => assertProductionSendDoesNotUseOpenCodeRun(diagnostic.args)).toThrowError(
      'OpenCode production send uses the persistent serve harness, not opencode run.',
    );
  });

  it('routes the opencode-cli connection through the persistent serve harness', () => {
    expect(shouldDispatchOpenCodeThroughHarness({ id: 'opencode-cli', adapterId: 'opencode-cli' })).toBe(
      true,
    );
    expect(shouldDispatchOpenCodeThroughHarness({ id: 'openai-codex', adapterId: 'codex-cli' })).toBe(
      false,
    );
  });

  it('refuses static-list catalog execution and keeps live OpenCode as the only authority', () => {
    expect(() => assertCatalogExecutionAllowed('static-display')).toThrowError(
      'Static model lists cannot execute',
    );
    expect(() => assertCatalogExecutionAllowed('live-opencode')).not.toThrow();
  });

  it('always resolves a safe absolute working directory for production send', () => {
    const resolved = resolveProductionWorkingDirectory(undefined);
    expect(isSafeAbsoluteWorkingDirectory(resolved)).toBe(true);
    expect(resolveProductionWorkingDirectory('   ')).toBe(resolved);
    expect(resolveProductionWorkingDirectory('C:\\workspace')).toBe('C:\\workspace');
    expect(() => resolveProductionWorkingDirectory('..\\relative')).toThrowError(
      'OpenCode requires a safe absolute working directory.',
    );
  });

  it('rejects unsupported effort variants instead of silently downgrading', () => {
    expect(assertSupportedOpenCodeEffort('high', ['low', 'medium', 'high'])).toBe('high');
    expect(() => assertSupportedOpenCodeEffort('xhigh', ['low', 'medium', 'high'])).toThrowError(
      'unsupported',
    );
    expect(() => assertSupportedOpenCodeEffort('high', [])).toThrowError('unsupported');
    expect(assertSupportedOpenCodeEffort(undefined, ['high'])).toBeUndefined();
  });

  it('gates production send on the live OpenCode catalog and exact live variants', () => {
    const providers = [
      {
        id: 'openai',
        name: 'OpenAI',
        connected: true,
        models: [
          {
            id: 'gpt-5.6-sol',
            name: 'gpt-5.6-sol',
            variants: ['low', 'medium', 'high'],
          },
        ],
      },
    ];
    expect(catalogSourceFromLiveProviders(providers)).toBe('live-opencode');
    expect(catalogSourceFromLiveProviders([])).toBe('static-display');
    expect(
      liveVariantsForSelection(providers, { providerId: 'openai', modelId: 'gpt-5.6-sol' }),
    ).toEqual(['low', 'medium', 'high']);
    expect(
      assertProductionOpenCodeSend({
        providers,
        selection: { providerId: 'openai', modelId: 'gpt-5.6-sol' },
        variant: 'high',
      }),
    ).toBe('high');
    expect(() =>
      assertProductionOpenCodeSend({
        providers,
        selection: { providerId: 'openai', modelId: 'gpt-5.6-sol' },
        variant: 'xhigh',
      }),
    ).toThrowError(/unsupported/);
    expect(() =>
      assertProductionOpenCodeSend({
        providers: [],
        selection: { providerId: 'openai', modelId: 'gpt-5.6-sol' },
      }),
    ).toThrowError(/Static model lists cannot execute/);
    expect(() =>
      assertProductionOpenCodeSend({
        providers,
        selection: { providerId: 'openai', modelId: 'missing-model' },
      }),
    ).toThrowError(/not available/);
  });
});
