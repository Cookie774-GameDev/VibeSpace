import type { MilestoneItem, MilestoneStatus } from '@/features/inspector/types';

export const MILESTONE_COLUMNS: ReadonlyArray<{ status: MilestoneStatus; title: string }> = [
  { status: 'todo', title: 'Todo' },
  { status: 'working', title: 'In Progress' },
  { status: 'done', title: 'Done' },
];

export function bucketMilestones(
  items: MilestoneItem[],
): Record<MilestoneStatus, MilestoneItem[]> {
  const out: Record<MilestoneStatus, MilestoneItem[]> = {
    todo: [],
    working: [],
    done: [],
  };
  for (const item of items) {
    out[item.status].push(item);
  }
  for (const key of Object.keys(out) as MilestoneStatus[]) {
    out[key].sort((a, b) => b.updatedAt - a.updatedAt);
  }
  return out;
}

export function milestoneProgress(items: MilestoneItem[]): {
  done: number;
  total: number;
  percent: number;
  open: number;
} {
  const total = items.length;
  const done = items.filter((i) => i.status === 'done').length;
  const open = total - done;
  return {
    done,
    total,
    open,
    percent: total > 0 ? Math.round((done / total) * 100) : 0,
  };
}
