import * as React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ChatActivityEvent } from './types';
import {
  ChatListActivityIndicator,
  resolveChatListActivity,
  type ChatListRunSignal,
} from './chatListActivity';

const NOW = Date.parse('2026-08-03T05:00:00.000Z');

function run(status: string, updatedAt = NOW): ChatListRunSignal {
  return {
    chatId: 'chat-1',
    status,
    updatedAt: new Date(updatedAt).toISOString(),
  };
}

function event(
  status: ChatActivityEvent['status'],
  kind: ChatActivityEvent['kind'],
  ts = NOW - 200,
): ChatActivityEvent {
  return {
    id: `${status}-${kind}-${ts}`,
    chatId: 'chat-1',
    status,
    kind,
    title: 'Canonical activity',
    ts,
  };
}

describe('resolveChatListActivity', () => {
  it('maps canonical run and tool states without inventing activity', () => {
    expect(resolveChatListActivity({ runs: [], events: [], nowMs: NOW }).state).toBe('idle');
    expect(
      resolveChatListActivity({
        runs: [run('waiting-for-approval')],
        events: [],
        nowMs: NOW,
      }).state,
    ).toBe('queued');
    expect(resolveChatListActivity({ runs: [run('planning')], events: [], nowMs: NOW }).state).toBe(
      'thinking',
    );
    expect(
      resolveChatListActivity({
        runs: [run('running')],
        events: [event('running', 'tool')],
        nowMs: NOW,
      }).state,
    ).toBe('tool');
  });

  it('uses recent event cadence for streaming speed and clamps the cycle', () => {
    const slow = resolveChatListActivity({
      runs: [run('running')],
      events: [event('done', 'agent', NOW - 3_500)],
      nowMs: NOW,
    });
    const fast = resolveChatListActivity({
      runs: [run('running')],
      events: Array.from({ length: 12 }, (_, index) => event('done', 'agent', NOW - index * 180)),
      nowMs: NOW,
    });

    expect(slow.state).toBe('streaming');
    expect(fast.state).toBe('streaming');
    expect(fast.cycleMs).toBeLessThan(slow.cycleMs);
    expect(fast.cycleMs).toBeGreaterThanOrEqual(450);
    expect(slow.cycleMs).toBeLessThanOrEqual(1_800);
  });

  it('settles recent completion and error once, then becomes idle', () => {
    expect(
      resolveChatListActivity({
        runs: [run('completed', NOW - 1_000)],
        events: [],
        nowMs: NOW,
      }).state,
    ).toBe('complete');
    expect(
      resolveChatListActivity({
        runs: [run('failed', NOW - 1_000)],
        events: [],
        nowMs: NOW,
      }).state,
    ).toBe('error');
    expect(
      resolveChatListActivity({
        runs: [run('completed', NOW - 6_000)],
        events: [],
        nowMs: NOW,
      }).state,
    ).toBe('idle');
  });
});

describe('ChatListActivityIndicator', () => {
  it('reserves a stable non-interactive slot and mounts motion only for real work', () => {
    const idle = render(<ChatListActivityIndicator runs={[]} events={[]} now={() => NOW} />);
    const slot = idle.getByTestId('chat-activity-slot');
    expect(slot.getAttribute('aria-hidden')).toBe('true');
    expect(slot.querySelector('[data-chat-activity-indicator]')).toBeNull();

    idle.rerender(
      <ChatListActivityIndicator
        runs={[run('running')]}
        events={[event('running', 'tool')]}
        now={() => NOW}
      />,
    );
    expect(slot.querySelector('[data-chat-activity-indicator]')?.getAttribute('data-state')).toBe(
      'tool',
    );
    expect(
      slot.querySelector('[data-chat-activity-indicator]')?.getAttribute('data-agent-motion'),
    ).toBe('magnetic-matrix');
    expect(slot.querySelectorAll('[data-chat-activity-cell]')).toHaveLength(16);
    expect(slot.querySelector('video')).toBeNull();
  });
});
