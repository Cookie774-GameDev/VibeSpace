import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  armExactChildRunResumePropagation,
  dispatchExactChildRunControl,
} from '../../lib/actions/registryJarvisCore';
import { createEscapeCancelState, recordEscapePress } from './composerEscapeCancel';

const readSource = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

const composerSource = readSource('src/features/chat/Composer.tsx');
const queueSource = readSource('src/features/chat/QueuedMessagesBar.tsx');
const runtimeSource = readSource('src/lib/ai/runtime.ts');
const jarvisActionsSource = readSource('src/lib/actions/registryJarvisCore.ts');

describe('Composer active-request cancel and resume contract', () => {
  it('requires three Escape presses before an active request is cancelled', () => {
    let state = createEscapeCancelState();
    const first = recordEscapePress(state, 1_000);
    state = first.state;
    const second = recordEscapePress(state, 1_200);
    state = second.state;
    const third = recordEscapePress(state, 1_400);

    expect(first.shouldCancelRun).toBe(false);
    expect(second.shouldCancelRun).toBe(false);
    expect(third.shouldCancelRun).toBe(true);
    expect(composerSource).toContain('if (result.shouldCancelRun)');
    expect(composerSource).toContain("new CustomEvent('jarvis:cancel'");
  });

  it('keeps queued messages editable, removable, and dispatchable after the active turn', () => {
    expect(composerSource).toContain("enqueueCurrentMessage(text, 'after-tool')");
    expect(composerSource).toContain("enqueueCurrentMessage(text, 'after-run')");
    expect(composerSource).toContain('messages={queuedMessages}');
    expect(queueSource).toContain('aria-label="Edit queued message"');
    expect(queueSource).toContain("'Steer queued message'");
    expect(queueSource).toContain('aria-label="Delete queued message"');
  });

  it('exposes an active stop affordance and a stopped resume/play affordance', () => {
    expect(
      /aria-label=.{0,160}Stop (?:current )?request/s.test(composerSource),
      'Composer needs an accessible active-request Stop control.',
    ).toBe(true);
    expect(
      /aria-label=.{0,160}Resume (?:current )?request/s.test(composerSource),
      'Composer needs an accessible stopped-request Resume control.',
    ).toBe(true);
    expect(/\bPlay\b/.test(composerSource), 'The stopped control needs a play/resume icon.').toBe(
      true,
    );
  });

  it('routes an explicit steer without silently converting it into a cancel-and-resend', () => {
    const composerSteer = composerSource.slice(
      composerSource.indexOf('queuedInterruptInFlightRef.current = queued.id;'),
      composerSource.indexOf('interruptQueuedRef.current = interruptAndSendQueued'),
    );
    const runtimeSteer = runtimeSource.slice(
      runtimeSource.indexOf('const handleSteer'),
      runtimeSource.indexOf('const handleSendEvent'),
    );
    expect(
      composerSource.includes("new CustomEvent('jarvis:steer'"),
      'Composer does not dispatch an explicit jarvis:steer request.',
    ).toBe(true);
    expect(
      runtimeSource.includes("'jarvis:steer'"),
      'The AI runtime does not register a steer event.',
    ).toBe(true);
    expect(/handleSteer/.test(runtimeSource), 'The AI runtime has no steer handler.').toBe(true);
    expect(composerSteer).not.toContain("new CustomEvent('jarvis:cancel'");
    expect(composerSteer).toContain('onAccepted: (cancellationKey: string)');
    expect(runtimeSteer).toContain('pendingSteersByChatId.set');
    expect(runtimeSteer).toContain('cancellationTaskTracker.request');
    expect(runtimeSteer).toContain('controller.abort()');
  });

  it('provides a runtime resume event instead of treating resume as a new send', () => {
    expect(
      composerSource.includes("new CustomEvent('jarvis:resume'"),
      'Composer does not dispatch a resume request.',
    ).toBe(true);
    expect(
      runtimeSource.includes("'jarvis:resume'"),
      'The AI runtime does not register a resume event.',
    ).toBe(true);
    expect(/handleResume/.test(runtimeSource), 'The AI runtime has no resume handler.').toBe(true);
  });

  it('addresses child-agent cancellation through a detail shape the runtime understands', () => {
    const dispatched: Event[] = [];
    dispatchExactChildRunControl(
      'jarvis:cancel',
      [
        { agentId: 'agent-a', childChatId: 'child-a' },
        { agentId: 'agent-a-duplicate', childChatId: 'child-a' },
        { agentId: 'agent-b', childChatId: 'child-b' },
      ],
      (event) => dispatched.push(event),
    );

    expect(dispatched.map((event) => event.type)).toEqual(['jarvis:cancel', 'jarvis:cancel']);
    expect(dispatched.map((event) => (event as CustomEvent).detail)).toEqual([
      { chatId: 'child-a' },
      { chatId: 'child-b' },
    ]);
    expect(jarvisActionsSource).toContain(
      "dispatchExactChildRunControl('jarvis:cancel', launchedChildren)",
    );
    expect(
      /interface CancelDetail[\s\S]{0,260}chatId\?:/.test(runtimeSource),
      'CancelDetail cannot address a child chat even though agent actions send childChatId.',
    ).toBe(true);
    expect(
      /handleCancel[\s\S]{0,1800}detail\.chatId/.test(runtimeSource),
      'The cancel handler ignores child chat identity.',
    ).toBe(true);
  });

  it('propagates resume to child/subagent execution as well as the parent turn', () => {
    const dispatched: Event[] = [];
    dispatchExactChildRunControl(
      'jarvis:resume',
      [{ agentId: 'agent-a', childChatId: 'child-a' }],
      (event) => dispatched.push(event),
      () => 'child-cancel-key-a',
    );

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.type).toBe('jarvis:resume');
    expect((dispatched[0] as CustomEvent).detail).toEqual({
      chatId: 'child-a',
      cancellationKey: 'child-cancel-key-a',
    });
    const observed: Array<{ chatId?: string; cancellationKey?: string }> = [];
    const observe = (event: Event) => {
      observed.push((event as CustomEvent<{ chatId?: string; cancellationKey?: string }>).detail);
    };
    window.addEventListener('jarvis:resume', observe);
    armExactChildRunResumePropagation('parent-a', [{ agentId: 'agent-a', childChatId: 'child-a' }]);
    window.dispatchEvent(
      new CustomEvent('jarvis:resume', {
        detail: { chatId: 'parent-a', cancellationKey: 'parent-cancel-key' },
      }),
    );
    window.removeEventListener('jarvis:resume', observe);

    const childResume = observed.find((detail) => detail.chatId === 'child-a');
    expect(childResume?.cancellationKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(childResume?.cancellationKey).not.toBe('parent-cancel-key');
    expect(jarvisActionsSource).toContain(
      "dispatchExactChildRunControl('jarvis:resume', children)",
    );
    expect(
      /handleResume[\s\S]{0,900}(?:chatId|child)/.test(runtimeSource),
      'The runtime resume path does not address child execution.',
    ).toBe(true);
  });
});
