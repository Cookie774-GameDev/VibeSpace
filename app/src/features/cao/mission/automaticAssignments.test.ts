import { describe, expect, it } from 'vitest';
import { applyAutomaticAssignments } from './automaticAssignments';
import { planCaoMission } from './missionPlanner';
const mission = planCaoMission({
  missionId: 'm',
  accountId: 'a',
  workspaceId: 'w',
  projectId: 'p',
  objective: 'Build a game',
  workers: ['one', 'two'].map((targetId) => ({
    targetId,
    kind: 'chat',
    backend: 'codex',
    modelId: 'verified-model',
    assignment: 'Awaiting CAO analysis',
    ownedPaths: [],
  })),
});
const rows = [
  { targetId: 'one', assignment: 'Build gameplay and test movement.', ownedPaths: ['src/game.ts'] },
  {
    targetId: 'two',
    assignment: 'Review the implementation without editing files.',
    ownedPaths: [],
  },
];
describe('CAO generated assignments', () => {
  it('uses model assignments while retaining verified routes', () => {
    const next = applyAutomaticAssignments(mission, JSON.stringify({ workers: rows }));
    expect(next.workers[0]?.assignment).toBe(rows[0]!.assignment);
    expect(next.workers[0]?.modelId).toBe('verified-model');
  });
  it.each([
    [rows[0]],
    [rows[0], rows[0]],
    [rows[0], { ...rows[1], targetId: 'stranger' }],
    [rows[0], { ...rows[1], assignment: '' }],
    [rows[0], { ...rows[1], ownedPaths: ['src'] }],
  ])('rejects incomplete, duplicate, unknown, empty or overlapping assignments', (...workers) => {
    expect(() => applyAutomaticAssignments(mission, JSON.stringify({ workers }))).toThrow();
  });
});
