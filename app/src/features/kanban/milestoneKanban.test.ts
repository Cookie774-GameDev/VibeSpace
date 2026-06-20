import { describe, expect, it } from 'vitest';
import type { MilestoneItem } from '@/features/inspector/types';
import { bucketMilestones, milestoneProgress } from './milestoneKanban';

function ms(partial: Partial<MilestoneItem> & Pick<MilestoneItem, 'id' | 'title' | 'status'>): MilestoneItem {
  const now = Date.now();
  return {
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

describe('milestoneKanban', () => {
  it('buckets milestones by status and sorts by updatedAt desc', () => {
    const items: MilestoneItem[] = [
      ms({ id: 'a', title: 'A', status: 'todo', updatedAt: 100 }),
      ms({ id: 'b', title: 'B', status: 'todo', updatedAt: 300 }),
      ms({ id: 'c', title: 'C', status: 'working', updatedAt: 200 }),
      ms({ id: 'd', title: 'D', status: 'done', updatedAt: 50 }),
    ];
    const buckets = bucketMilestones(items);
    expect(buckets.todo.map((i) => i.id)).toEqual(['b', 'a']);
    expect(buckets.working.map((i) => i.id)).toEqual(['c']);
    expect(buckets.done.map((i) => i.id)).toEqual(['d']);
  });

  it('computes progress percent', () => {
    const items: MilestoneItem[] = [
      ms({ id: '1', title: 'One', status: 'done' }),
      ms({ id: '2', title: 'Two', status: 'todo' }),
      ms({ id: '3', title: 'Three', status: 'working' }),
      ms({ id: '4', title: 'Four', status: 'done' }),
    ];
    expect(milestoneProgress(items)).toEqual({
      done: 2,
      total: 4,
      open: 2,
      percent: 50,
    });
  });

  it('returns zero progress for empty board', () => {
    expect(milestoneProgress([])).toEqual({
      done: 0,
      total: 0,
      open: 0,
      percent: 0,
    });
  });
});
