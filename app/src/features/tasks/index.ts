/**
 * Public surface of the tasks feature.
 *
 * Components, services, hooks, and helpers live behind this barrel so
 * other features (voice, command palette, council, action extractor)
 * import from `@/features/tasks` rather than reaching into modules.
 */

// Components
export { TodoPanel } from './TodoPanel';
export { TaskCard } from './TaskCard';
export { TaskComposer } from './TaskComposer';
export { SnoozePopover } from './SnoozePopover';
export { DraftTaskList } from './DraftTaskList';

// Component prop types
export type { TaskCardProps } from './TaskCard';
export type { TaskComposerProps } from './TaskComposer';
export type { SnoozePopoverProps } from './SnoozePopover';
export type { DraftTaskListProps } from './DraftTaskList';

// Services
export { TaskService } from './TaskService';
export {
  createTask,
  updateTask,
  completeTask,
  reopenTask,
  deleteTask,
  snoozeReminder,
  dismissReminder,
} from './TaskService';

export {
  pickReminderTimes,
  isQuietHour,
  nextNonQuietTime,
} from './Scheduler';
export type { SchedulerContext } from './Scheduler';

export {
  startNotificationLoop,
  pollOnce,
  ensureNotificationPermission,
} from './NotificationEngine';
export type { JarvisReminderEventDetail } from './NotificationEngine';
export * as NotificationEngine from './NotificationEngine';

// Hooks
export {
  useTasks,
  useTodayTasks,
  useUpcomingTasks,
  useRecentlyCompletedTasks,
} from './hooks';

// Store (for the action extractor agent / council to push drafts)
export { useTaskStore } from './store';

// Helpers
export { parseTaskInput } from './parseTaskInput';

// Convenient namespace alias for the scheduler
export * as Scheduler from './Scheduler';
