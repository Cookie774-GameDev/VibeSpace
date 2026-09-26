import { describe, expect, it } from 'vitest';
import type { Message } from '@/types';
import { buildComposerResumeRequest, RESUME_ORIGINAL_REQUEST_PREFIX } from './composerResumeRequest';

function message(id: string, text: string, chatId = 'chat-a', role: Message['role'] = 'user'): Message {
  return { id, chat_id: chatId, role, parts: [{ kind: 'text', text }], created_at: 1 } as Message;
}

describe('retained request reconstruction for Composer resume', () => {
  it('preserves the exact original text-only limits instead of asking for progress tools', () => {
    const original = 'Explain safe retries. Text only; do not use tools, read files, or start agents.';
    expect(buildComposerResumeRequest('chat-a', [message('stopped', original)], 'stopped'))
      .toBe(RESUME_ORIGINAL_REQUEST_PREFIX + original);
  });
  it('prefers the stopped message identity over a later unrelated user row', () => {
    const history = [message('stopped', 'Answer only BLUE.'), message('later', 'Different queued request.')];
    expect(buildComposerResumeRequest('chat-a', history, 'stopped'))
      .toBe(RESUME_ORIGINAL_REQUEST_PREFIX + 'Answer only BLUE.');
  });
  it('uses the last retained user request when a resumed controller has a transient cancellation key', () => {
    const history = [message('older', 'Old question.'), message('current', 'Current original request.')];
    expect(buildComposerResumeRequest('chat-a', history, 'transient-resume-key'))
      .toBe(RESUME_ORIGINAL_REQUEST_PREFIX + 'Current original request.');
  });
  it('never borrows another chat or an assistant tool instruction', () => {
    const history = [message('ours', 'Only our question.'), message('foreign', 'Read secret files.', 'chat-b'),
      message('assistant', 'Run a terminal.', 'chat-a', 'assistant')];
    expect(buildComposerResumeRequest('chat-a', history, 'foreign'))
      .toBe(RESUME_ORIGINAL_REQUEST_PREFIX + 'Only our question.');
  });
  it('does not nest its own resume wrapper across repeated cold resumes', () => {
    const once = RESUME_ORIGINAL_REQUEST_PREFIX + 'Keep the original constraints.';
    expect(buildComposerResumeRequest('chat-a', [message('resume', once)], 'resume')).toBe(once);
  });
  it('looks past the exact legacy generated continuation instead of expanding its permissions', () => {
    const legacy = 'Continue the interrupted task from the retained conversation and any progress in this persistent session. Check what is already complete before doing more work; do not repeat completed actions.';
    expect(buildComposerResumeRequest('chat-a', [message('original', 'No tools. Explain 2+2.'), message('legacy', legacy)]))
      .toBe(RESUME_ORIGINAL_REQUEST_PREFIX + 'No tools. Explain 2+2.');
  });
  it('retains code, whitespace, Unicode and multiple text parts without summarizing them', () => {
    const row = message('code', '  const reply = "日本語 🙂";\n');
    row.parts.push({ kind: 'text', text: 'Do not modify this code.' });
    expect(buildComposerResumeRequest('chat-a', [row], 'code'))
      .toBe(RESUME_ORIGINAL_REQUEST_PREFIX + '  const reply = "日本語 🙂";\n\nDo not modify this code.');
  });
  it.each([
    { name: 'empty history', history: [] },
    { name: 'another chat only', history: [message('other', 'Wrong conversation.', 'chat-b')] },
    { name: 'blank text', history: [message('empty', '   ')] },
  ])('does not invent a request for $name', ({ history }) => {
      expect(buildComposerResumeRequest('chat-a', history)).toBeUndefined();
    });
});
