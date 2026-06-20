import { useMemo } from 'react';
import { useMilestonesStore } from '@/features/inspector/milestonesStore';
import type { MilestoneItem } from '@/features/inspector/types';
import { bucketMilestones, milestoneProgress } from './milestoneKanban';

/** Live milestone list from the same zustand store as the Inspector Trace panel. */
export function useKanbanMilestones(): MilestoneItem[] {
  return useMilestonesStore((s) => s.items);
}

export function useKanbanMilestoneBuckets(items: MilestoneItem[]) {
  return useMemo(() => bucketMilestones(items), [items]);
}

export function useKanbanMilestoneProgress(items: MilestoneItem[]) {
  return useMemo(() => milestoneProgress(items), [items]);
}
