import { describe, expect, it } from 'vitest';
import { deriveChatTitle, isDefaultChatTitle } from './chatLifecycle';

describe('isDefaultChatTitle', () => {
  it('recognises placeholder titles', () => {
    expect(isDefaultChatTitle('')).toBe(true);
    expect(isDefaultChatTitle('New chat')).toBe(true);
    expect(isDefaultChatTitle('New chat 3')).toBe(true);
    expect(isDefaultChatTitle('Chat with Jarvis')).toBe(true);
    expect(isDefaultChatTitle('Deploy plan')).toBe(false);
  });
});

describe('deriveChatTitle', () => {
  it('uses the first sentence and strips markdown', () => {
    expect(deriveChatTitle('Fix the login bug. We should reset tokens.')).toBe('Fix the login bug');
    expect(deriveChatTitle('```ts\nconst x = 1;\n```\nHello world.')).toBe('Hello world');
  });

  it('returns empty for unusable text', () => {
    expect(deriveChatTitle('')).toBe('');
    expect(deriveChatTitle('ok')).toBe('');
  });
});
