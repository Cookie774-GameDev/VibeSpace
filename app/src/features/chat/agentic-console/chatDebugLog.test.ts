import { describe, expect, it } from 'vitest';
import type { Message } from '@/types';
import { buildChatDebugLog } from './chatDebugLog';

const message = (id: string, chat = 'chat'): Message =>
  ({
    id: id as Message['id'],
    chat_id: chat as Message['chat_id'],
    role: 'assistant',
    created_at: 1000,
    updated_at: 1200,
    usage: { model: 'exact-model', input_tokens: 0, output_tokens: 5, provenance: 'estimated' },
    parts: [
      {
        kind: 'tool_call',
        tool: 'shell',
        call_id: 'call-1',
        args: { command: 'echo hello', apiKey: 'private-value' },
      },
    ],
  });

describe('chat debug log snapshot', () => {
  it('preserves exact telemetry and correlation while removing other chats and secrets', () => {
    const log = buildChatDebugLog({
      chatId: 'chat',
      messages: [message('m'), message('foreign', 'other')],
      activity: [],
      runs: [],
      coverage: [],
      exportedAt: 2000,
      rendererUptimeMs: 800,
    });
    expect(log.messages).toHaveLength(1);
    expect(log.messages[0].usage).toMatchObject({
      input_tokens: 0,
      output_tokens: 5,
      model: 'exact-model',
      provenance: 'estimated',
    });
    expect(JSON.stringify(log)).toContain('call-1');
    expect(JSON.stringify(log)).not.toContain('private-value');
    expect(log.rendererStartedAt).toBe(1200);
  });

  it('redacts free-text credentials and marks oversized content instead of silently clipping it', () => {
    const row = message('m');
    row.parts = [
      { kind: 'text', text: 'Bearer abcdefghijklmnopqrstuvwxyz' },
      { kind: 'reasoning', text: 'x'.repeat(70000) },
    ];
    const log = buildChatDebugLog({
      chatId: 'chat',
      messages: [row],
      activity: [],
      runs: [],
      coverage: [],
    });
    expect(JSON.stringify(log)).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(JSON.stringify(log)).toContain('truncated');
    expect(log.coverage.join(' ')).toContain('snapshot');
  });
});
