import { describe, expect, it } from 'vitest';
import { encodeCodexThreadCache, decodeCodexThreadCache } from './codexThreadCache';
import type { CodexDynamicTool } from './codexAppServerProtocol';
const tool = (name: string, field = 'limit'): CodexDynamicTool => ({
  type: 'function',
  name,
  description: name,
  inputSchema: { type: 'object', properties: { [field]: { type: 'integer' } } },
});
describe('Codex implicit thread reuse is bound to dynamic tool definitions', () => {
  it('resumes only an identical manifest', () => {
    const tools = [tool('vibespace_context')];
    const raw = encodeCodexThreadCache('thread_exact', tools);
    expect(decodeCodexThreadCache(raw, tools)).toBe('thread_exact');
    expect(decodeCodexThreadCache(raw, [...tools, tool('terminal_list')])).toBeUndefined();
    expect(decodeCodexThreadCache(raw, [tool('vibespace_context', 'other')])).toBeUndefined();
  });
  it('does not depend on ordering of code-owned tool definitions', () => {
    const tools = [tool('terminal_list'), tool('skills_list')];
    expect(
      decodeCodexThreadCache(encodeCodexThreadCache('thread_exact', tools), [...tools].reverse()),
    ).toBe('thread_exact');
  });
  it('does not guess the manifest for legacy or malformed cache data', () => {
    const tools = [tool('terminal_list')];
    for (const raw of [
      'thread_legacy',
      'null',
      '{}',
      'not json',
      JSON.stringify({ version: 2, sessionId: 'bad id', manifest: '[]' }),
    ])
      expect(decodeCodexThreadCache(raw, tools)).toBeUndefined();
  });
  it('retains ordinary non-dynamic thread cache behavior', () => {
    expect(encodeCodexThreadCache('thread_plain')).toBe('thread_plain');
    expect(decodeCodexThreadCache('thread_plain')).toBe('thread_plain');
    expect(decodeCodexThreadCache('invalid id')).toBeUndefined();
  });
});
