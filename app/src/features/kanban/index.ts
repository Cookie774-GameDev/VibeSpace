/**
 * Public surface of the kanban feature.
 *
 * Milestone board backed by `useMilestonesStore` — same source of truth as
 * Inspector → Trace. Import via `@/features/kanban`.
 */

export { KanbanPage } from './KanbanPage';
export { KanbanColumn } from './KanbanColumn';
export type { KanbanColumnProps } from './KanbanColumn';
export { KanbanCard } from './KanbanCard';
export type { KanbanCardProps } from './KanbanCard';
export {
  useKanbanMilestones,
  useKanbanMilestoneBuckets,
  useKanbanMilestoneProgress,
} from './hooks';
export { bucketMilestones, milestoneProgress, MILESTONE_COLUMNS } from './milestoneKanban';
