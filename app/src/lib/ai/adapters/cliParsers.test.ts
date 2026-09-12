import { describe, expect, it } from 'vitest';
import { normalizeClaudeJsonl } from './claude';
import { CLAUDE_CLI_DEFINITION } from './claude';
import { normalizeCodexJsonl } from './codex';
import { CODEX_CLI_DEFINITION } from './codex';
import { normalizeCopilotJsonl } from './copilot';
import { COPILOT_CLI_DEFINITION } from './copilot';
import {
  DEFAULT_JSONL_LIMITS,
  preferNativeCliExecutable,
  responseUsageSnapshot,
  type JsonlParserLimits,
} from './cliBridge';
import { normalizeGeminiJsonl } from './gemini';
import { GEMINI_CLI_DEFINITION } from './gemini';
import { normalizeOpenCodeJsonl } from './opencode';
import { OPENCODE_CLI_DEFINITION } from './opencode';
import { normalizeQwenJsonl } from './qwen';
import { QWEN_CLI_DEFINITION } from './qwen';
import type { ProviderEvent } from './types';

function jsonl(...records: unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

function joined(events: ProviderEvent[]): string {
  return JSON.stringify(events);
}

describe('protected prompt declarations', () => {
  it('prefers a native Windows CLI binary over an extensionless npm shim', () => {
    expect(
      preferNativeCliExecutable('codex', [
        {
          executableId: 'shim',
          requestedName: 'codex',
          executablePath: String.raw`C:\Users\viper\AppData\Roaming\npm\codex`,
        },
        {
          executableId: 'native',
          requestedName: 'codex',
          executablePath: String.raw`C:\Users\viper\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.exe`,
        },
      ])?.executableId,
    ).toBe('native');
  });

  it('pins all six parser-backed CLI definitions to one preamble strategy', () => {
    expect(
      [
        CODEX_CLI_DEFINITION,
        CLAUDE_CLI_DEFINITION,
        GEMINI_CLI_DEFINITION,
        COPILOT_CLI_DEFINITION,
        QWEN_CLI_DEFINITION,
        OPENCODE_CLI_DEFINITION,
      ].map(({ connectionId, promptTransport }) => [connectionId, promptTransport]),
    ).toEqual([
      ['openai-codex', 'prefixed-preamble'],
      ['anthropic-claude-code', 'prefixed-preamble'],
      ['google-gemini-cli', 'prefixed-preamble'],
      ['github-copilot-cli', 'prefixed-preamble'],
      ['qwen-code', 'prefixed-preamble'],
      ['opencode-cli', 'prefixed-preamble'],
    ]);
  });
});

describe('Codex JSONL normalization', () => {
  it('preserves only bounded shared events from a successful turn', () => {
    const events = normalizeCodexJsonl(
      jsonl(
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'item.updated', item: { type: 'reasoning', text: 'checking' } },
        { type: 'item.completed', item: { type: 'agent_message', text: 'answer' } },
        {
          type: 'item.completed',
          item: {
            type: 'command_execution',
            id: 'call-1',
            command: 'rg',
            status: 'completed',
            aggregated_output: 'must not escape',
          },
        },
        {
          type: 'turn.completed',
          usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
          model: 'gpt-5.5-codex',
        },
      ),
    );

    expect(events).toEqual([
      { type: 'session', sessionId: 'thread-1' },
      { type: 'reasoning', delta: 'checking' },
      { type: 'text', delta: 'answer' },
      { type: 'tool', name: 'rg', status: 'completed', callId: 'call-1' },
      { type: 'model', modelId: 'gpt-5.5-codex' },
      {
        type: 'usage',
        usage: {
          capturedAt: expect.any(Number),
          inputTokens: { value: 10, provenance: 'provider-reported' },
          outputTokens: { value: 4, provenance: 'provider-reported' },
          totalTokens: { value: 14, provenance: 'provider-reported' },
          quota: {
            value: undefined,
            provenance: 'unavailable',
            reason: 'Subscription quota is not reported by this response.',
          },
        },
      },
      { type: 'done', finishReason: 'completed' },
    ]);
    expect(joined(events)).not.toContain('must not escape');
  });
});

describe('Claude JSONL normalization', () => {
  it('keeps exact response metadata while marking subscription quota unavailable', () => {
    const events = normalizeClaudeJsonl(
      jsonl({
        type: 'result',
        subtype: 'success',
        session_id: 'session-7',
        model: 'claude-sonnet',
        result: 'finished',
        usage: { input_tokens: 20, output_tokens: 8 },
        total_cost_usd: 0.012,
      }),
    );
    const usage = events.find((event) => event.type === 'usage');

    expect(events).toContainEqual({ type: 'session', sessionId: 'session-7' });
    expect(events).toContainEqual({ type: 'model', modelId: 'claude-sonnet' });
    expect(events).toContainEqual({ type: 'text', delta: 'finished' });
    expect(usage).toEqual({
      type: 'usage',
      usage: {
        capturedAt: expect.any(Number),
        inputTokens: { value: 20, provenance: 'provider-reported' },
        outputTokens: { value: 8, provenance: 'provider-reported' },
        totalTokens: { value: 28, provenance: 'locally-observed' },
        costUsd: { value: 0.012, provenance: 'provider-reported' },
        quota: {
          value: undefined,
          provenance: 'unavailable',
          reason: 'Subscription quota is not reported by this response.',
        },
      },
    });
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'success' });
  });

  it('preserves tool status without forwarding tool input', () => {
    const events = normalizeClaudeJsonl(
      jsonl(
        {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'Read',
                input: { token: 'must-not-escape' },
              },
            ],
          },
        },
        { type: 'result', subtype: 'success', result: '' },
      ),
    );
    expect(events).toContainEqual({
      type: 'tool',
      name: 'Read',
      status: 'started',
      callId: 'tool-1',
    });
    expect(joined(events)).not.toContain('must-not-escape');
  });

  it('emits partial text once while preserving final metadata and tools', () => {
    const events = normalizeClaudeJsonl(
      jsonl(
        { type: 'system', subtype: 'init', session_id: 'session-8', model: 'claude-sonnet' },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'hel' },
          },
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'lo' },
          },
        },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'hello' },
              { type: 'tool_use', id: 'tool-2', name: 'Read', input: { secret: 'hidden' } },
            ],
          },
        },
        {
          type: 'result',
          subtype: 'success',
          session_id: 'session-8',
          model: 'claude-sonnet',
          result: 'hello',
          usage: { input_tokens: 9, output_tokens: 2 },
          total_cost_usd: 0.001,
        },
      ),
    );

    const textEvents = events.filter(
      (event): event is Extract<ProviderEvent, { type: 'text' }> => event.type === 'text',
    );
    expect(textEvents.map(({ delta }) => delta).join('')).toBe('hello');
    expect(textEvents).toHaveLength(2);
    expect(events).toContainEqual({ type: 'session', sessionId: 'session-8' });
    expect(events).toContainEqual({ type: 'model', modelId: 'claude-sonnet' });
    expect(events).toContainEqual({
      type: 'tool',
      name: 'Read',
      status: 'started',
      callId: 'tool-2',
    });
    expect(events.some((event) => event.type === 'usage')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'success' });
    expect(joined(events)).not.toContain('hidden');
  });
});

describe('other approved JSONL normalizers', () => {
  it.each([
    [
      'Gemini',
      normalizeGeminiJsonl,
      jsonl(
        { type: 'init', session_id: 'gem-1', model: 'gemini-3' },
        { type: 'message', role: 'assistant', content: 'gemini text' },
        { type: 'result', status: 'success', stats: { input_tokens: 3, output_tokens: 2 } },
      ),
      'gemini text',
    ],
    [
      'Qwen',
      normalizeQwenJsonl,
      jsonl(
        { type: 'message', role: 'assistant', content: 'qwen text' },
        { type: 'result', status: 'success', usage: { input_tokens: 5, output_tokens: 6 } },
      ),
      'qwen text',
    ],
  ])('%s emits text and a terminal shared event', (_name, normalize, input, text) => {
    const events = normalize(input);
    expect(events).toContainEqual({ type: 'text', delta: text });
    expect(events.at(-1)?.type).toBe('done');
    expect(events.every((event) => typeof event.type === 'string')).toBe(true);
  });

  it('normalizes the current Copilot JSONL result shape without requiring status', () => {
    const events = normalizeCopilotJsonl(
      jsonl(
        { type: 'assistant.message', content: 'copilot text', model: 'gpt-5' },
        {
          type: 'result',
          exitCode: 0,
          sessionId: 'copilot-session-1',
          usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
        },
      ),
    );

    expect(events).toContainEqual({ type: 'text', delta: 'copilot text' });
    expect(events).toContainEqual({ type: 'session', sessionId: 'copilot-session-1' });
    expect(events).toContainEqual({ type: 'model', modelId: 'gpt-5' });
    expect(events).toContainEqual({
      type: 'usage',
      usage: {
        capturedAt: expect.any(Number),
        inputTokens: { value: 5, provenance: 'provider-reported' },
        outputTokens: { value: 2, provenance: 'provider-reported' },
        totalTokens: { value: 7, provenance: 'provider-reported' },
        quota: {
          value: undefined,
          provenance: 'unavailable',
          reason: 'Subscription quota is not reported by this response.',
        },
      },
    });
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'completed' });
  });

  it('normalizes OpenCode JSON events from their nested part envelope', () => {
    const events = normalizeOpenCodeJsonl(
      jsonl(
        {
          type: 'step_start',
          sessionID: 'open-1',
          part: {
            id: 'part-1',
            sessionID: 'open-1',
            messageID: 'message-1',
            type: 'step-start',
            snapshot: 'snapshot-1',
          },
        },
        {
          type: 'text',
          sessionID: 'open-1',
          part: {
            id: 'part-2',
            sessionID: 'open-1',
            messageID: 'message-1',
            type: 'text',
            text: 'opencode text',
          },
        },
        {
          type: 'tool_use',
          sessionID: 'open-1',
          part: {
            id: 'part-3',
            sessionID: 'open-1',
            messageID: 'message-1',
            type: 'tool',
            callID: 'call-1',
            tool: 'read',
            state: {
              status: 'completed',
              input: { token: 'must-not-escape' },
              output: 'must-not-escape',
            },
          },
        },
        {
          type: 'step_finish',
          sessionID: 'open-1',
          part: {
            id: 'part-4',
            sessionID: 'open-1',
            messageID: 'message-1',
            type: 'step-finish',
            reason: 'stop',
            cost: 0.02,
            tokens: { input: 7, output: 4, reasoning: 0, cache: { read: 1, write: 0 } },
          },
        },
      ),
    );

    expect(events).toContainEqual({ type: 'session', sessionId: 'open-1' });
    expect(events).toContainEqual({ type: 'text', delta: 'opencode text' });
    expect(events).toContainEqual({
      type: 'tool',
      name: 'read',
      status: 'completed',
      callId: 'call-1',
    });
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
    expect(joined(events)).not.toContain('must-not-escape');
  });
});

describe('response usage provenance', () => {
  it('marks a locally summed total as locally observed', () => {
    expect(responseUsageSnapshot({ inputTokens: 2, outputTokens: 3 }).totalTokens).toEqual({
      value: 5,
      provenance: 'locally-observed',
    });
  });
});

describe('bounded untrusted output handling', () => {
  it('rejects malformed JSON without echoing its contents', () => {
    expect(() => normalizeCodexJsonl('{"type":"turn.completed",SECRET\n')).toThrowError(
      'Malformed provider JSONL at line 1',
    );
    try {
      normalizeCodexJsonl('{"type":"turn.completed",SECRET\n');
    } catch (error) {
      expect(String(error)).not.toContain('SECRET');
    }
  });

  it('rejects a stream that ends without a required terminal event', () => {
    expect(() =>
      normalizeClaudeJsonl(
        jsonl({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } }),
      ),
    ).toThrowError('Provider stream ended without a terminal event');
  });

  it('rejects a malformed required terminal record', () => {
    expect(() =>
      normalizeOpenCodeJsonl(jsonl({ type: 'step_finish', part: { type: 'step-finish' } })),
    ).toThrowError('Malformed OpenCode terminal event');
  });

  it('rejects oversized lines and total input with explicit bounds', () => {
    const tiny: JsonlParserLimits = {
      ...DEFAULT_JSONL_LIMITS,
      maxLineChars: 40,
      maxTotalChars: 1_000,
    };
    expect(() =>
      normalizeCodexJsonl(
        jsonl({ type: 'item.completed', item: { type: 'agent_message', text: 'x'.repeat(50) } }),
        tiny,
      ),
    ).toThrowError('Provider JSONL line exceeds 40 characters');

    const totalOnly: JsonlParserLimits = {
      ...DEFAULT_JSONL_LIMITS,
      maxLineChars: 80,
      maxTotalChars: 90,
    };
    expect(() =>
      normalizeCodexJsonl(
        `${JSON.stringify({ type: 'future-a', value: 'x'.repeat(30) })}\n${JSON.stringify({ type: 'future-b', value: 'y'.repeat(30) })}\n`,
        totalOnly,
      ),
    ).toThrowError('Provider JSONL input exceeds 90 characters');
  });

  it('rejects event floods with an explicit count bound', () => {
    const limited: JsonlParserLimits = {
      ...DEFAULT_JSONL_LIMITS,
      maxEvents: 2,
    };
    expect(() =>
      normalizeCodexJsonl(
        jsonl(
          { type: 'item.completed', item: { type: 'agent_message', text: 'one' } },
          { type: 'item.completed', item: { type: 'agent_message', text: 'two' } },
          { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
        ),
        limited,
      ),
    ).toThrowError('Provider event count exceeds 2');
  });

  it('turns unknown future records into one bounded warning', () => {
    const events = normalizeCodexJsonl(
      jsonl(
        { type: `future.${'x'.repeat(5_000)}`, raw: 'must not escape' },
        { type: 'another.future', raw: 'also hidden' },
        { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
      ),
    );
    const warnings = events.filter((event) => event.type === 'warning');
    expect(warnings).toHaveLength(1);
    expect(
      (warnings[0] as Extract<ProviderEvent, { type: 'warning' }>).message.length,
    ).toBeLessThanOrEqual(256);
    expect(joined(events)).not.toContain('must not escape');
    expect(joined(events)).not.toContain('also hidden');
  });

  it('preserves a provider warning without exposing arbitrary fields', () => {
    const events = normalizeCodexJsonl(
      jsonl(
        { type: 'warning', message: 'context window is nearly full', raw: 'hidden' },
        {
          type: 'turn.completed',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ),
    );
    expect(events).toContainEqual({
      type: 'warning',
      message: 'context window is nearly full',
    });
    expect(joined(events)).not.toContain('hidden');
  });

  it('drops auth/account payloads and redacts control sequences and secrets', () => {
    const events = normalizeClaudeJsonl(
      jsonl(
        { type: 'auth_status', account: 'private@example.com', token: 'plain-secret' },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: '\u001b[31mhello\u001b[0m' },
          },
        },
        { type: 'result', subtype: 'error', error: 'Bearer abc.def.ghi token=plain-secret' },
      ),
    );
    const serialized = joined(events);
    expect(serialized).not.toContain('private@example.com');
    expect(serialized).not.toContain('abc.def.ghi');
    expect(serialized).not.toContain('plain-secret');
    expect(serialized).not.toContain('\u001b');
    expect(serialized).toContain('[REDACTED]');
  });
});
