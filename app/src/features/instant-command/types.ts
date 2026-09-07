import type { AssistantIntent } from '@/features/assistant/intents';
import type { ExpectedTerminalProcessBinding } from '@/features/terminals/terminalRefs';
import type { CommandFamily, CommandSafety } from './catalogTypes';

export type TerminalSelector = Readonly<{
  ordinal?: number;
  sessionId?: string;
  paneId?: string;
  label?: string;
  agentSlug?: string;
  provider?: string;
  scope?: 'one' | 'all';
}>;

export type InstantCommand =
  | { kind: 'legacy'; intent: Exclude<AssistantIntent, { kind: 'unknown' }> }
  | { kind: 'open-agent-cli'; provider: string; count: number; modelId?: string; prompt?: string }
  | { kind: 'open-model-picker' }
  | { kind: 'terminal-message'; target: TerminalSelector; payload: string }
  | { kind: 'agent-message'; target: TerminalSelector; payload: string }
  | { kind: 'terminal-broadcast'; target: TerminalSelector; payload: string }
  | {
      kind: 'catalog';
      id: string;
      family: CommandFamily;
      authority: string;
      safety: CommandSafety;
      slots: Readonly<Record<string, unknown>>;
    };

export type InstantInputClassification =
  | { status: 'matched'; command: InstantCommand }
  | { status: 'rejected'; reason: string }
  | { status: 'unmatched' };

export type InstantResultCode =
  | 'legacy'
  | 'legacy_failed'
  | 'queued'
  | 'opened'
  | 'target_missing'
  | 'target_ambiguous'
  | 'target_not_ready'
  | 'confirmation_required'
  | 'queue_failed';

export type InstantResult = Readonly<{
  ok: boolean;
  code: InstantResultCode;
  message: string;
}>;

export type InstantCommandExecutionContext = Readonly<{
  correlationId: string;
  accountId: string;
  workspaceId: string;
  projectId: string;
}>;

export type LiveTerminalTarget = Readonly<{
  sessionId: string;
  paneId: string;
  projectId: string | null;
  ordinal: number;
  label?: string;
  agentSlug?: string;
  provider?: string;
  command?: string;
  processIdentity: ExpectedTerminalProcessBinding;
}>;

export type TargetResolution =
  | { kind: 'one'; target: LiveTerminalTarget }
  | { kind: 'many'; targets: LiveTerminalTarget[] }
  | { kind: 'missing' }
  | { kind: 'ambiguous' };
