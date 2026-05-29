import type { ContextRef, Timestamped, TaskId, ReminderId, AgentId, ProjectId, WorkspaceId } from './common';

/**
 * Task priority. Drives default notification channels and scheduler weight.
 */
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

/**
 * Task lifecycle status.
 */
export type TaskStatus = 'open' | 'in_progress' | 'blocked' | 'done' | 'cancelled';

/**
 * Energy level required to do the task.
 * Smart scheduler aligns reminder timing with the user's
 * historical energy peaks for similar tags.
 */
export type EnergyLevel = 'low' | 'medium' | 'high';

/**
 * Fibonacci-style effort points.
 */
export type EffortPoints = 1 | 2 | 3 | 5 | 8 | 13;

/**
 * Notification delivery channel.
 */
export type NotificationChannel =
  | 'banner' // OS desktop banner (Tauri or browser Notification API)
  | 'push' // mobile push (Phase 2)
  | 'watch' // Apple Watch / Wear OS (Phase 2)
  | 'email' // digest or single
  | 'sms' // Twilio (Phase 2)
  | 'voice' // Jarvis says it out loud
  | 'imessage' // iOS only (Phase 2)
  | 'in_app'; // shown in to-do panel only

/**
 * One scheduled reminder for a task. A task can have many.
 */
export type Reminder = {
  id: ReminderId;
  task_id: TaskId;
  fires_at: number; // unix ms
  channels: NotificationChannel[];
  message_override?: string;
  status: 'scheduled' | 'fired' | 'snoozed' | 'dismissed' | 'completed';
  snooze_history: Array<{ snoozed_at: number; until: number; reason?: string }>;
  /** Why Jarvis chose this time (verbalized to user) */
  smart_reason?: string;
};

/**
 * The core task entity.
 *
 * Field commentary:
 * - `effort` + `context_tags` + `energy_required` drive smart scheduling.
 * - `source_refs` keeps provenance from chats / meetings / voice.
 * - `external_ids` enables 1:1 mapping to Apple Reminders / Google Tasks / Linear / Notion etc.
 * - `completion_evidence` records what convinced Jarvis to auto-mark done.
 */
export type Task = {
  id: TaskId;
  workspace_id: WorkspaceId;
  project_id?: ProjectId;

  title: string;
  notes?: string; // markdown
  status: TaskStatus;
  priority: TaskPriority;

  // Time
  due_at?: number; // unix ms - hard deadline
  scheduled_for?: number; // unix ms - intent to do at
  estimated_duration_min?: number;

  // Smart scheduling inputs
  effort: EffortPoints;
  context_tags: string[];
  location?: string;
  energy_required: EnergyLevel;
  blocked_by_task_ids?: TaskId[];

  // Reminders attached to this task
  reminders: Reminder[];

  // Provenance
  created_by: 'user_voice' | 'user_text' | 'extracted_chat' | 'extracted_meeting' | 'agent';
  source_refs: ContextRef[];
  agent_owner?: AgentId;

  // External system links
  external_ids?: {
    apple_reminders?: string;
    google_tasks?: string;
    todoist?: string;
    linear?: string;
    notion?: string;
    github?: string;
  };

  // Completion
  done_at?: number;
  completion_evidence?: ContextRef;
} & Timestamped;

/**
 * Used by the action extractor agent - a draft task waiting for user accept.
 */
export type DraftTask = {
  id: string;
  task: Partial<Task>;
  confidence: number; // 0..1
  trigger_phrase: string;
  source_ref: ContextRef;
  diff_against_existing?: TaskId;
  created_at: number;
};

/**
 * Helper - input for creating a task. Sets reasonable defaults.
 */
export type TaskInput = Pick<Task, 'title'> & Partial<Omit<Task, 'id' | 'created_at' | 'updated_at' | 'reminders'>> & {
  reminders?: Omit<Reminder, 'id' | 'task_id' | 'snooze_history' | 'status'>[];
};

/**
 * Quiet-hours window. The notification engine respects these.
 */
export type QuietHours = {
  enabled: boolean;
  start_hour: number; // 0-23 local time
  end_hour: number; // 0-23 local time
  /** Override day flags (Sun=0, Sat=6) */
  full_day_quiet: boolean[];
};
