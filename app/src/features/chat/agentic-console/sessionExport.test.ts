import { describe, expect, it } from 'vitest';
import { buildChatSessionExport, sessionExportFilename } from './sessionExport';

describe('sessionExport', () => {
  it('builds a per-chat log payload with full messages and projection blocks', () => {
    const payload = buildChatSessionExport({
      chatId: 'chat_1',
      exportedAt: '2026-08-06T12:00:00.000Z',
      summary: { status: 'done', model: 'llama3.2' },
      messages: [
        {
          id: 'm1',
          role: 'user',
          created_at: '2026-08-06T11:00:00.000Z',
          parts: [{ kind: 'text', text: 'hello' }],
        },
        {
          id: 'm2',
          role: 'assistant',
          created_at: '2026-08-06T11:01:00.000Z',
          usage: { model: 'llama3.2', inputTokens: 1, outputTokens: 2 },
          parts: [{ kind: 'text', text: 'hi' }],
        },
      ],
      blocks: [{ kind: 'prompt', id: 'b1' }],
    });

    expect(payload.version).toBe(2);
    expect(payload.chatId).toBe('chat_1');
    expect(payload.messages).toHaveLength(2);
    expect(payload.messages[0]?.parts).toEqual([{ kind: 'text', text: 'hello' }]);
    expect(payload.messages[1]?.usage).toEqual({
      model: 'llama3.2',
      inputTokens: 1,
      outputTokens: 2,
    });
    expect(payload.blocks).toEqual([{ kind: 'prompt', id: 'b1' }]);
    expect(sessionExportFilename('chat/1')).toBe('vibespace-session-chat_1.json');
  });
});
