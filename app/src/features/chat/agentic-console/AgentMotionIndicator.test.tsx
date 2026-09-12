import * as React from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatActivityCategory, ChatActivityKind, ChatActivityStatus } from '../activity/types';
import {
  AgentMotionIndicator,
  PerceptibleAgentMotionIndicator,
  resolveAgentMotion,
  type AgentMotionKind,
} from './AgentMotionIndicator';

afterEach(() => {
  vi.useRealTimers();
});

const EXPECTED_MOTIONS: ReadonlyArray<readonly [ChatActivityCategory, AgentMotionKind]> = [
  ['thinking', 'cursor-forge'],
  ['file', 'stack-shift'],
  ['writing', 'code-shimmer'],
  ['coordination', 'nine-dot-fold'],
  ['context', 'twin-loop'],
  ['learning', 'breathing-brackets'],
  ['response', 'glyph-current'],
];

describe('resolveAgentMotion', () => {
  it.each(EXPECTED_MOTIONS)(
    'maps structured %s activity to %s',
    (activityCategory, expectedMotion) => {
      expect(resolveAgentMotion({ status: 'running', activityCategory })).toBe(expectedMotion);
    },
  );

  it.each<ChatActivityStatus>(['pending', 'running'])(
    'animates structured work while it is %s',
    (status) => {
      expect(resolveAgentMotion({ status, activityCategory: 'context' })).toBe('twin-loop');
    },
  );

  it.each<ChatActivityStatus>(['done', 'error', 'cancelled'])(
    'does not animate work after the %s terminal transition',
    (status) => {
      expect(resolveAgentMotion({ status, activityCategory: 'response' })).toBeNull();
    },
  );

  it('uses deterministic structured-kind fallbacks without inspecting English labels', () => {
    const titledLikeOtherActivities = [
      {
        status: 'running',
        activityKind: 'diff',
        title: 'Reading files and preparing a response',
        expected: 'code-shimmer',
      },
      {
        status: 'running',
        activityKind: 'file',
        title: 'Coordinating agents',
        expected: 'stack-shift',
      },
      {
        status: 'running',
        activityKind: 'url',
        title: 'Writing code',
        expected: 'twin-loop',
      },
      {
        status: 'running',
        activityKind: 'subagent',
        title: 'Final response',
        expected: 'nine-dot-fold',
      },
      {
        status: 'running',
        activityKind: 'tool',
        title: 'General thinking',
        expected: 'cursor-forge',
      },
      {
        status: 'running',
        activityKind: 'agent',
        title: 'Writing code',
        expected: 'cursor-forge',
      },
    ] as const;

    expect(
      titledLikeOtherActivities.map(({ expected: _expected, ...evidence }) =>
        resolveAgentMotion(evidence),
      ),
    ).toEqual(titledLikeOtherActivities.map(({ expected }) => expected));
  });

  it('uses generic thinking for unknown live evidence and no motion without a live status', () => {
    expect(resolveAgentMotion({ status: 'running' })).toBe('cursor-forge');
    expect(resolveAgentMotion({ activityCategory: 'thinking' })).toBeNull();
  });

  it('falls back deterministically when persisted activity has an unknown category', () => {
    expect(
      resolveAgentMotion({
        status: 'running',
        activityCategory: 'unknown-category' as ChatActivityCategory,
        activityKind: 'file',
      }),
    ).toBe('stack-shift');
  });

  it('uses generic thinking when both persisted category and kind are invalid', () => {
    expect(
      resolveAgentMotion({
        status: 'running',
        activityCategory: 'unknown-category' as ChatActivityCategory,
        activityKind: 'unknown-kind' as ChatActivityKind,
      }),
    ).toBe('cursor-forge');
  });
});

describe('AgentMotionIndicator', () => {
  it.each(EXPECTED_MOTIONS)(
    'renders %s motion as decorative in standard and compact layouts',
    (_activityCategory, motion) => {
      const standard = render(<AgentMotionIndicator motion={motion} />);
      const standardMotion = standard.container.querySelector('[data-agent-motion]');

      expect(standardMotion?.getAttribute('data-agent-motion')).toBe(motion);
      expect(standardMotion?.getAttribute('data-agent-motion-size')).toBe('standard');
      expect(standardMotion?.getAttribute('aria-hidden')).toBe('true');
      expect(standardMotion?.classList.contains('agent-motion-slot')).toBe(true);
      expect(standardMotion?.querySelector('.agent-motion')).not.toBeNull();
      expect((standardMotion as HTMLElement | null)?.style.opacity).toBe('1');

      standard.rerender(<AgentMotionIndicator motion={motion} compact />);
      expect(
        standard.container
          .querySelector('[data-agent-motion]')
          ?.getAttribute('data-agent-motion-size'),
      ).toBe('compact');
    },
  );

  it('shows a new truthful phase immediately while the prior phase completes a bounded exit', () => {
    vi.useFakeTimers();
    const view = render(<PerceptibleAgentMotionIndicator motion="twin-loop" />);

    view.rerender(<PerceptibleAgentMotionIndicator motion="cursor-forge" />);

    expect(
      [...view.container.querySelectorAll('[data-agent-motion]')].map((node) => [
        node.getAttribute('data-agent-motion'),
        node.getAttribute('data-agent-motion-presence'),
      ]),
    ).toEqual([
      ['cursor-forge', 'current'],
      ['twin-loop', 'exiting'],
    ]);

    act(() => {
      vi.advanceTimersByTime(1500);
    });

    expect(
      [...view.container.querySelectorAll('[data-agent-motion]')].map((node) =>
        node.getAttribute('data-agent-motion'),
      ),
    ).toEqual(['cursor-forge']);

    view.rerender(<PerceptibleAgentMotionIndicator motion={null} />);
    expect(
      view.container
        .querySelector('[data-agent-motion="cursor-forge"]')
        ?.getAttribute('data-agent-motion-presence'),
    ).toBe('exiting');

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(view.container.querySelector('[data-agent-motion]')).toBeNull();
  });
});
