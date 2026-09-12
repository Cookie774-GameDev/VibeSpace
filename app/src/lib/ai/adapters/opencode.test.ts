import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildOpenCodeInvocation,
  openCodeCliAdapter,
  parseOpenCodeModelList,
  requireOpenCodeModelId,
} from './opencode';

describe('OpenCode model discovery and invocation', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it('keeps spaces and supported punctuation in one literal argv value', () => {
    const modelId = 'openrouter/Model v2 (beta)+preview';
    const invocation = buildOpenCodeInvocation({ prompt: 'hello', modelId });
    expect(invocation.args).toEqual(['run', '--format', 'json', '--model', modelId]);
    expect(invocation.args.at(-1)).toBe(modelId);
    expect(invocation.stdin).toBe('hello');
  });

  it('rejects option injection, controls, bidi overrides, and oversized IDs', () => {
    for (const id of ['--model=attacker', 'openai/gpt\n--yolo', 'openai/\u202egpt']) {
      expect(() => requireOpenCodeModelId(id)).toThrowError(
        'OpenCode CLI model ID contains unsafe characters',
      );
    }
    expect(() => requireOpenCodeModelId(`openai/${'x'.repeat(512)}`)).toThrowError(
      'OpenCode CLI model ID exceeds 512 characters',
    );
  });

  it('parses, attributes, and de-duplicates text model discovery output', () => {
    expect(
      parseOpenCodeModelList('openai/gpt-5\nopenrouter/Model v2 (beta)+preview\nopenai/gpt-5\n'),
    ).toEqual([
      { id: 'openai/gpt-5', providerId: 'openai' },
      {
        id: 'openrouter/Model v2 (beta)+preview',
        providerId: 'openrouter',
      },
    ]);
  });

  it('supports structured discovery and ignores invalid records without exposing them', () => {
    expect(
      parseOpenCodeModelList(
        JSON.stringify([
          { id: 'anthropic/claude-sonnet' },
          { id: '--unsafe' },
          { name: 'missing-id' },
        ]),
      ),
    ).toEqual([{ id: 'anthropic/claude-sonnet', providerId: 'anthropic' }]);
  });

  it('bounds untrusted discovery output', () => {
    expect(() => parseOpenCodeModelList('x'.repeat(65_537))).toThrowError(
      'OpenCode model list output exceeds the safe bound',
    );
    expect(() => parseOpenCodeModelList('[not-json')).toThrowError(
      'Malformed OpenCode model list output',
    );
  });

  it('discovers models through the read-only native CLI probe for the model selector', async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'cli_bridge_scan') {
        return {
          executables: [
            {
              executableId: 'opencode-verified',
              requestedName: 'opencode',
              executablePath: '/verified/opencode',
            },
          ],
        };
      }
      if (command === 'cli_bridge_probe') {
        return {
          exitCode: 0,
          stdout: {
            data: 'openai/gpt-5\nopenrouter/Model v2 (beta)+preview\n',
            truncated: false,
          },
          stderr: { data: '', truncated: false },
          timedOut: false,
        };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    await expect(openCodeCliAdapter.listModels?.()).resolves.toEqual([
      { id: 'openai/gpt-5', label: 'openai/gpt-5' },
      {
        id: 'openrouter/Model v2 (beta)+preview',
        label: 'openrouter/Model v2 (beta)+preview',
      },
    ]);
    expect(invoke).toHaveBeenNthCalledWith(2, 'cli_bridge_probe', {
      request: expect.objectContaining({
        executableId: 'opencode-verified',
        args: ['models', 'openai', '--refresh'],
      }),
    });
  });

  it.each([
    ['timeout', { exitCode: null, timedOut: true, truncated: false }],
    ['nonzero exit', { exitCode: 1, timedOut: false, truncated: false }],
    ['truncated output', { exitCode: 0, timedOut: false, truncated: true }],
  ])('fails closed when model discovery reports %s', async (_name, terminal) => {
    vi.mocked(invoke).mockImplementation(async (command, payload) => {
      if (command === 'cli_bridge_scan') {
        return {
          executables: [
            {
              executableId: 'opencode-verified',
              requestedName: 'opencode',
              executablePath: '/verified/opencode',
            },
          ],
        };
      }
      if (command === 'cli_bridge_probe') {
        expect(payload).toEqual({
          request: {
            executableId: 'opencode-verified',
            args: ['models', 'openai', '--refresh'],
            timeoutMs: 3_000,
            outputLimitBytes: 16_384,
          },
        });
        return {
          exitCode: terminal.exitCode,
          stdout: { data: 'openai/gpt-5', truncated: terminal.truncated },
          stderr: { data: '', truncated: false },
          timedOut: terminal.timedOut,
        };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    await expect(openCodeCliAdapter.listModels?.()).rejects.toThrowError(
      'CLI model discovery failed',
    );
  });
});
