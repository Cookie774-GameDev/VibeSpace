import { describe, expect, it } from 'vitest';
import { resolveAgentMotion } from './AgentMotionIndicator';

describe('resolveAgentMotion', () => {
  it('uses one canonical animation for every live Jarvis activity', () => {
    const liveActivities = [
      { status: 'running', activityKind: 'tool', title: 'Updating Context map' },
      { status: 'running', activityKind: 'subagent', title: 'Coordinating subagents' },
      { status: 'running', activityKind: 'file', title: 'Reading file context' },
      { status: 'running', activityKind: 'diff', title: 'Writing code' },
      { status: 'running', activityKind: 'agent', title: 'Preparing the final response' },
      { status: 'pending', activityKind: 'agent', title: 'Planning the task' },
    ] as const;

    expect(liveActivities.map((activity) => resolveAgentMotion(activity))).toEqual(
      liveActivities.map(() => 'cursor-forge'),
    );
  });

  it('does not animate completed, failed, or cancelled work', () => {
    expect(resolveAgentMotion({ status: 'done', title: 'Complete' })).toBeNull();
    expect(resolveAgentMotion({ status: 'error', title: 'Failed' })).toBeNull();
    expect(resolveAgentMotion({ status: 'cancelled', title: 'Cancelled' })).toBeNull();
  });
});
