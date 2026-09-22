import { describe, expect, it } from 'vitest';
import { planCaoMission } from './missionPlanner';

describe('CAO mission planner', () => {
  it('requires unique target ownership and keeps workers account/workspace scoped', () => {
    expect(() =>
      planCaoMission({
        missionId: 'm',
        accountId: 'a',
        workspaceId: 'w',
        projectId: 'p',
        objective: 'Build the game',
        workers: [
          {
            targetId: 'chat-1',
            kind: 'chat',
            connectionId: 'openai-codex',
            assignment: 'UI',
            ownedPaths: ['src/ui'],
          },
          { targetId: 'chat-1', kind: 'chat', assignment: 'tests', ownedPaths: ['tests'] },
        ],
      }),
    ).toThrow('cao_mission_target_duplicate');
    expect(
      planCaoMission({
        missionId: 'm',
        accountId: 'a',
        workspaceId: 'w',
        projectId: 'p',
        objective: 'Build the game',
        workers: [
          {
            targetId: 'chat-1',
            kind: 'chat',
            connectionId: 'openai-codex',
            assignment: 'UI',
            ownedPaths: ['src/ui'],
          },
          { targetId: 'terminal-1', kind: 'terminal', assignment: 'tests', ownedPaths: ['tests'] },
        ],
      }),
    ).toMatchObject({
      status: 'planning',
      latestPlanRevision: 1,
      workers: [{ targetId: 'chat-1', connectionId: 'openai-codex' }, { targetId: 'terminal-1' }],
    });
  });

  it('rejects ancestor, separator, case, and dot aliases while preserving path whitespace', () => {
    expect(() =>
      planCaoMission({
        missionId: 'm',
        accountId: 'a',
        workspaceId: 'w',
        projectId: null,
        objective: 'Build',
        workers: [
          { targetId: 'one', kind: 'chat', assignment: 'one', ownedPaths: ['src'] },
          { targetId: 'two', kind: 'terminal', assignment: 'two', ownedPaths: ['src/file.ts'] },
        ],
      }),
    ).toThrow('cao_mission_path_overlap');
    expect(() =>
      planCaoMission({
        missionId: 'm',
        accountId: 'a',
        workspaceId: 'w',
        projectId: null,
        objective: 'Build',
        workers: [
          { targetId: 'one', kind: 'chat', assignment: 'one', ownedPaths: ['src\\ui'] },
          {
            targetId: 'two',
            kind: 'terminal',
            assignment: 'two',
            ownedPaths: ['./SRC/ui/button.ts'],
          },
        ],
      }),
    ).toThrow('cao_mission_path_overlap');
    const mission = planCaoMission({
      missionId: 'm',
      accountId: 'a',
      workspaceId: 'w',
      projectId: null,
      objective: 'Build',
      workers: [
        { targetId: 'one', kind: 'chat', assignment: 'one', ownedPaths: ['src/with  spaces.ts'] },
      ],
    });
    expect(mission.workers[0]?.ownedPaths).toEqual(['src/with  spaces.ts']);
  });
});
