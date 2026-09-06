import { describe, expect, it, vi } from 'vitest';
import { buildChatDebugLog } from './chatDebugLog';
import { downloadChatDebugLog, renderChatDebugLogHtml } from './chatDebugLogHtml';
import type { Message } from '@/types';

describe('offline HTML chat log', () => {
  it('downloads an HTML file with a safe name and releases its blob after the click', () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:test');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('vibespace-chat-log-chat_1.html');
    });
    try {
      downloadChatDebugLog(
        buildChatDebugLog({ chatId: 'chat/1', messages: [], activity: [], runs: [], coverage: [] }),
      );
      expect(click).toHaveBeenCalledOnce();
      expect(createObjectURL.mock.calls[0][0].type).toBe('text/html;charset=utf-8');
      expect(revokeObjectURL).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:test');
    } finally {
      click.mockRestore();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
  it('renders both views, saved timings, exact tokens, commands, diffs and recorded reasoning safely', () => {
    const log = buildChatDebugLog({
      chatId: 'chat',
      exportedAt: 5000,
      rendererUptimeMs: 1000,
      coverage: [],
      runs: [],
      messages: [
        {
          id: 'm',
          chat_id: 'chat',
          role: 'user',
          created_at: 1000,
          updated_at: 2000,
          usage: { model: 'model-A', input_tokens: 0, output_tokens: 7 },
          parts: [
            { kind: 'text', text: '<script>alert(1)</script>' },
            { kind: 'tool_call', tool: 'shell', call_id: 'call-A', args: { command: 'git diff' } },
            { kind: 'reasoning', text: 'Checking the recorded diff.' },
          ],
        } as Message,
      ],
      activity: [
        {
          id: 'edit',
          chatId: 'chat',
          kind: 'diff',
          status: 'error',
          title: 'Edit failed',
          filePath: 'a.ts',
          diff: '-old\n+new',
          ts: 3000,
        },
      ],
    });
    const html = renderChatDebugLogHtml(log);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelectorAll('script,iframe,img,object')).toHaveLength(0);
    expect(doc.querySelector('#simple')).not.toBeNull();
    expect(doc.querySelector('#detailed')).not.toBeNull();
    expect(doc.body.textContent).toContain('git diff');
    expect(doc.body.textContent).toContain('-old');
    expect(doc.body.textContent).toContain('Edit failed');
    expect(doc.body.textContent).toContain('model-A');
    expect(doc.body.textContent).toContain('1970-01-01T00:00:01.000Z');
    expect(doc.body.textContent).toContain('Checking the recorded diff.');
    expect(doc.body.textContent).toContain('not recorded');
    expect(doc.body.textContent).toContain('call-A');
    expect(html).toContain('default-src');
  });
});
