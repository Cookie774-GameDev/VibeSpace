import { beforeEach, describe, expect, it, vi } from 'vitest';

const { authChecked, authStates, bind, capture, ensureDetection, release, send } = vi.hoisted(
  () => ({
    authChecked: vi.fn(),
    authStates: vi.fn(),
    bind: vi.fn(),
    capture: vi.fn(),
    ensureDetection: vi.fn(),
    release: vi.fn(),
    send: vi.fn(),
  }),
);

vi.mock('./adapters/autoDetectConnections', () => ({
  ensureExternalConnectionAutoDetection: ensureDetection,
}));

vi.mock('./connectionState', () => ({
  isConnectionSessionChecked: authChecked,
  readConnectionSessionPickerStates: authStates,
}));

vi.mock('@/lib/harness/toolGatewayAuthority', () => ({
  bindToolGatewaySessionAuthority: bind,
  captureToolGatewayAuthorityClaim: capture,
  releaseToolGatewaySessionAuthority: release,
}));

vi.mock('./adapters/codex', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./adapters/codex')>();
  return { ...actual, codexCliAdapter: { id: 'codex-cli', send } };
});

import { CODEX_CLI_CONNECTION } from './adapters/catalog';
import { runSubscriptionCliBridge } from './subscriptionCliBridge';

describe('Codex subscription Context Map authority', () => {
  beforeEach(() => {
    authChecked.mockReset().mockReturnValue(true);
    authStates.mockReset().mockReturnValue({
      'openai-codex': { available: true, auth: 'authenticated' },
    });
    bind.mockReset().mockReturnValue(true);
    capture.mockReset().mockReturnValue({ scope: {}, generation: 1 });
    ensureDetection.mockReset().mockResolvedValue({});
    release.mockReset();
    send.mockReset().mockImplementation(() =>
      (async function* () {
        yield { type: 'text', delta: 'answer' };
        yield { type: 'done', finishReason: 'completed' };
      })(),
    );
  });

  it('joins pending current-session detection before exact dispatch', async () => {
    let checked = false;
    let resolveDetection: (() => void) | undefined;
    ensureDetection.mockImplementationOnce(
      () =>
        new Promise<Record<string, never>>((resolve) => {
          resolveDetection = () => {
            checked = true;
            resolve({});
          };
        }),
    );
    authChecked.mockImplementation(() => checked);
    authStates.mockImplementation(() =>
      checked ? { 'openai-codex': { available: true, auth: 'authenticated' } } : {},
    );

    const response = runSubscriptionCliBridge({
      connection: CODEX_CLI_CONNECTION,
      requestId: 'request-detection-join',
      prompt: 'hello',
      modelId: 'gpt-5.6-luna',
      reasoningEffort: 'xhigh',
    });

    await Promise.resolve();
    expect(ensureDetection).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();

    resolveDetection?.();
    await expect(response).resolves.toMatchObject({ text: 'answer', model: 'gpt-5.6-luna' });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![0]).toMatchObject({
      connection: CODEX_CLI_CONNECTION,
      modelId: 'gpt-5.6-luna',
      reasoningEffort: 'xhigh',
    });
  });

  it('preserves AbortError when cancelled during current-session detection', async () => {
    const controller = new AbortController();
    let resolveDetection: (() => void) | undefined;
    ensureDetection.mockImplementationOnce(
      () =>
        new Promise<Record<string, never>>((resolve) => {
          resolveDetection = () => resolve({});
        }),
    );
    const response = runSubscriptionCliBridge({
      connection: CODEX_CLI_CONNECTION,
      requestId: 'request-detection-abort',
      prompt: 'research',
      signal: controller.signal,
      tools: { vibespace_context: true },
    });

    await Promise.resolve();
    controller.abort();
    resolveDetection?.();
    await expect(response).rejects.toMatchObject({ name: 'AbortError' });
    expect(capture).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('requires fresh exact-current-session authentication immediately before send', async () => {
    const rejectedStates = [
      {
        name: 'unknown',
        checked: true,
        states: { 'openai-codex': { available: true, auth: 'unknown' } },
      },
      {
        name: 'unauthenticated',
        checked: true,
        states: { 'openai-codex': { available: true, auth: 'unauthenticated' } },
      },
      {
        name: 'unavailable',
        checked: true,
        states: { 'openai-codex': { available: false, auth: 'authenticated' } },
      },
      {
        name: 'missing',
        checked: true,
        states: {},
      },
      {
        name: 'stale prior-session state',
        checked: false,
        states: { 'openai-codex': { available: true, auth: 'authenticated' } },
      },
      {
        name: 'connection-mismatched state',
        checked: true,
        states: { 'anthropic-claude': { available: true, auth: 'authenticated' } },
      },
    ] as const;

    for (const state of rejectedStates) {
      authChecked.mockReturnValueOnce(state.checked);
      authStates.mockReturnValueOnce(state.states);
      await expect(
        runSubscriptionCliBridge({
          connection: CODEX_CLI_CONNECTION,
          requestId: `request-${state.name}`,
          prompt: 'hello',
        }),
      ).rejects.toThrow('not authenticated for this session');
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('re-reads authentication after authority binding and releases on auth loss', async () => {
    let currentState: Record<
      string,
      { available: boolean; auth: 'authenticated' | 'unauthenticated' | 'unknown' }
    > = {
      'openai-codex': { available: true, auth: 'authenticated' },
    };
    authStates.mockImplementation(() => currentState);
    bind.mockImplementationOnce(() => {
      currentState = {
        'openai-codex': { available: false, auth: 'unauthenticated' },
      };
      return true;
    });

    await expect(
      runSubscriptionCliBridge({
        connection: CODEX_CLI_CONNECTION,
        requestId: 'request-auth-loss',
        prompt: 'research',
        tools: { vibespace_context: true },
      }),
    ).rejects.toThrow('not authenticated for this session');

    expect(bind).toHaveBeenCalledWith('request-auth-loss', expect.anything());
    expect(send).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith('request-auth-loss');
  });

  it('preserves pre-aborted AbortError behavior without claiming authority or dispatching', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runSubscriptionCliBridge({
        connection: CODEX_CLI_CONNECTION,
        requestId: 'request-aborted',
        prompt: 'research',
        signal: controller.signal,
        tools: { vibespace_context: true },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(authChecked).not.toHaveBeenCalled();
    expect(authStates).not.toHaveBeenCalled();
    expect(ensureDetection).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('releases exact authority when the current request aborts during dispatch', async () => {
    const controller = new AbortController();
    send.mockImplementationOnce(() =>
      (async function* () {
        yield { type: 'text', delta: 'partial' };
        controller.abort();
        yield { type: 'text', delta: 'late' };
      })(),
    );

    await expect(
      runSubscriptionCliBridge({
        connection: CODEX_CLI_CONNECTION,
        requestId: 'request-current-abort',
        prompt: 'research',
        signal: controller.signal,
        tools: { vibespace_context: true },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(send).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith('request-current-abort');
  });

  it('binds exact request authority, propagates only Context Map, and always releases', async () => {
    await expect(
      runSubscriptionCliBridge({
        connection: CODEX_CLI_CONNECTION,
        requestId: 'request-1',
        prompt: 'research',
        modelId: 'gpt-5.6-luna',
        reasoningEffort: 'xhigh',
        requirements: { tools: true },
        tools: { vibespace_context: true },
      }),
    ).resolves.toMatchObject({ text: 'answer', model: 'gpt-5.6-luna' });
    expect(bind).toHaveBeenCalledWith('request-1', expect.anything());
    expect(send.mock.calls[0]![0]).toMatchObject({
      requestId: 'request-1',
      modelId: 'gpt-5.6-luna',
      reasoningEffort: 'xhigh',
      tools: { vibespace_context: true },
    });
    expect(release).toHaveBeenCalledWith('request-1');

    send.mockImplementationOnce(() =>
      (async function* () {
        throw new Error('transport failed');
      })(),
    );
    await expect(
      runSubscriptionCliBridge({
        connection: CODEX_CLI_CONNECTION,
        requestId: 'request-2',
        prompt: 'research',
        tools: { vibespace_context: true },
      }),
    ).rejects.toThrow('transport failed');
    expect(release).toHaveBeenCalledWith('request-2');
  });

  it('rejects missing, unknown, or mixed tool scope before dispatch', async () => {
    const invalidToolScopes: ReadonlyArray<Readonly<Record<string, boolean>> | undefined> = [
      undefined,
      { 'terminal.list': true },
      { vibespace_context: true, 'terminal.list': true },
    ];
    for (const tools of invalidToolScopes) {
      await expect(
        runSubscriptionCliBridge({
          connection: CODEX_CLI_CONNECTION,
          requestId: 'request-bad',
          prompt: 'research',
          requirements: { tools: true },
          ...(tools ? { tools } : {}),
        }),
      ).rejects.toThrow(/tool scope/);
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('leaves ordinary Codex runs authority-free', async () => {
    await runSubscriptionCliBridge({
      connection: CODEX_CLI_CONNECTION,
      requestId: 'request-ordinary',
      prompt: 'hello',
    });
    expect(capture).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('fails closed when Codex reports a substituted model and still revokes authority', async () => {
    send.mockImplementationOnce(() =>
      (async function* () {
        yield { type: 'model', modelId: 'gpt-5.6-sol' };
      })(),
    );
    await expect(
      runSubscriptionCliBridge({
        connection: CODEX_CLI_CONNECTION,
        requestId: 'request-model',
        prompt: 'research',
        modelId: 'gpt-5.6-luna',
        tools: { vibespace_context: true },
      }),
    ).rejects.toThrow('model identity different');
    expect(release).toHaveBeenCalledWith('request-model');
  });
});
