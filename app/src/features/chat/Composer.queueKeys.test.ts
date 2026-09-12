import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, 'Composer.tsx'), 'utf8');

/**
 * Contract tests: keep keyboard queue semantics from drifting without a full Composer mount.
 */
describe('Composer queue keyboard contract', () => {
  it('wires bare Enter to after-tool enqueue while running and idle send otherwise', () => {
    expect(source).toContain("e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey");
    expect(source).toContain("enqueueCurrentMessage(text, 'after-tool')");
    expect(source).toContain("void handleSend(undefined, { flushMode: 'after-run' })");
  });

  it('wires the advertised Ctrl/Meta+Enter shortcut to one idle send', () => {
    expect(source).toContain(
      "e.key === 'Enter' && !e.shiftKey && (e.metaKey || e.ctrlKey) && !jarvisRunning",
    );
    expect(source).toContain("void handleSend(undefined, { flushMode: 'after-run' })");
  });

  it('leaves Shift+Enter available for a newline', () => {
    expect(source).not.toMatch(/e\.key === 'Enter' && e\.shiftKey[\s\S]{0,120}handleSend/u);
  });

  it('wires bare Tab to after-run enqueue while Jarvis is running', () => {
    expect(source).toContain("e.key === 'Tab' &&");
    expect(source).toContain("enqueueCurrentMessage(text, 'after-run')");
  });

  it('keeps Esc interrupt-send and adds Esc×3 cancel via jarvis:cancel', () => {
    expect(source).toContain('interruptAndSendQueued(queuedMessagesRef.current[0].id)');
    expect(source).toContain('recordEscapePress');
    expect(source).toContain('CANCELLED_BY_USER_TOAST');
    expect(source).toContain("new CustomEvent('jarvis:cancel'");
    expect(source).toContain('suppressQueueFlushOnUserCancelRef');
  });

  it('flushes after-tool on tool terminal status transitions only', () => {
    expect(source).toContain('shouldFlushOnToolTerminal');
    expect(source).toContain("queued.flushMode !== 'after-tool'");
    expect(source).not.toMatch(
      /event\.status === 'pending' \|\| event\.status === 'running'[\s\S]{0,120}interruptQueuedRef/,
    );
  });
});
