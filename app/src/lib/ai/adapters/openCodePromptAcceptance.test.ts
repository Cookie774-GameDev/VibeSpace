import { describe, expect, it, vi } from 'vitest';
import { newOpenCodeMessageId, sendOpenCodePromptOnce } from './openCodePromptAcceptance';

describe('OpenCode ambiguous prompt acceptance', () => {
  it('creates distinct sortable identifiers in the upstream format', () => {
    const first = newOpenCodeMessageId();
    const second = newOpenCodeMessageId();
    expect(first).toMatch(/^msg_[0-9a-f]{12}[A-Za-z0-9]{14}$/);
    expect(second > first).toBe(true);
  });
  it('recovers the exact accepted user message without submitting twice', async () => {
    const send = vi.fn().mockRejectedValue(new Error('OpenCode request timed out.'));
    const messages = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([
      { info: { id: 'msg_own', sessionID: 'ses_own', role: 'user' } },
    ]);
    await expect(sendOpenCodePromptOnce({sessionId:'ses_own',messageId:'msg_own',send,messages,sleep:async()=>{}})).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
    expect(messages).toHaveBeenCalledTimes(2);
  });
  it('never treats another request, another session, or assistant text as acceptance', async () => {
    const error = new Error('OpenCode request timed out.');
    const send = vi.fn().mockRejectedValue(error);
    const messages = vi.fn().mockResolvedValue([
      { info: { id: 'msg_other', sessionID: 'ses_own', role: 'user' } },
      { info: { id: 'msg_own', sessionID: 'ses_other', role: 'user' } },
      { info: { id: 'msg_own', sessionID: 'ses_own', role: 'assistant' } },
    ]);
    await expect(sendOpenCodePromptOnce({sessionId:'ses_own',messageId:'msg_own',send,messages,sleep:async()=>{}})).rejects.toBe(error);
    expect(send).toHaveBeenCalledTimes(1);
    expect(messages).toHaveBeenCalledTimes(12);
  });
  it('preserves explicit rejection and stops recovery at the deadline', async () => {
    const messages = vi.fn();
    await expect(sendOpenCodePromptOnce({sessionId:'s',messageId:'m',send:async()=>{throw Error('HTTP 403');},messages})).rejects.toThrow('403');
    expect(messages).not.toHaveBeenCalled();
    let time = 0;
    messages.mockImplementation(async()=>{time=60_000;return [{info:{id:'m',sessionID:'s',role:'user'}}];});
    await expect(sendOpenCodePromptOnce({sessionId:'s',messageId:'m',send:async()=>{throw Error('request timed out');},messages,now:()=>time})).rejects.toThrow('timed out');
    expect(messages).toHaveBeenCalledTimes(1);
  });
});
