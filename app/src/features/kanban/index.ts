/**
 * Public surface of the kanban feature.
 *
 * Other features should import via `@/features/kanban`. The page is the
 * primary export; subcomponents are exposed for completeness but rarely
 * imported directly elsewhere.
 */

export { KanbanPage } from './KanbanPage';
export { KanbanColumn } from './KanbanColumn';
export type { KanbanColumnProps } from './KanbanColumn';
export { KanbanCard } from './KanbanCard';
export type { KanbanCardProps } from './KanbanCard';
export { useKanbanTasks, useKanbanProjects } from './hooks';
