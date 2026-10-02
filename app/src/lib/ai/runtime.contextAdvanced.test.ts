import { afterEach, describe, expect, it } from 'vitest';
import { openCodeToolsForInteractionMode, prepareOpenCodeMessagesForInteractionMode } from './runtime';
import { setChatRlmEnabled } from '@/features/context/rlmPreferenceStore';
import type { LLMMessage } from './types';

const names = ['search', 'open', 'expand', 'address', 'trace'].map(operation => `vibespace_context_${operation}`);
const chatId = 's61-advanced-tool-policy';
afterEach(() => { setChatRlmEnabled(chatId, true); });
describe('actual advanced context tool admission', () => {
  it.each(names)('preserves explicit %s caller arguments without an investigation rewrite', name => {
    const messages: LLMMessage[] = [{ role: 'user', content: `Call ${name} with the exact arguments I supplied. Read only.` }];
    expect(prepareOpenCodeMessagesForInteractionMode(messages)).toBe(messages);
    expect(prepareOpenCodeMessagesForInteractionMode(messages, { contextToolEnabled: false })).toBe(messages);
  });
  it.each(['ask', 'plan', 'agent'] as const)('advertises the registered read-only tools in %s and honors persisted Off', mode => {
    const messages: LLMMessage[] = [{ role: 'user', content: 'Call vibespace_context_trace with the actual runId returned in this chat.' }];
    setChatRlmEnabled(chatId, true);
    const on = openCodeToolsForInteractionMode(mode, messages, { chatId });
    for (const name of names) expect(on[name]).toBe(true);
    expect(on['terminal.write']).toBe(false);
    setChatRlmEnabled(chatId, false);
    const off = openCodeToolsForInteractionMode(mode, messages, { chatId });
    for (const name of [...names, 'vibespace_context']) expect(off[name]).toBe(false);
  });
  it('retains direct-chat and explicit disk scope controls', () => {
    expect(Object.values(openCodeToolsForInteractionMode('ask', [{ role: 'user', content: 'Reply pong.' }])).every(value => !value)).toBe(true);
    const disk = openCodeToolsForInteractionMode('agent', [{ role: 'user', content: 'Call vibespace_context_search.' }], { explicitReadRoot: true });
    expect(Object.values(disk).every(value => !value)).toBe(true);
  });
});
