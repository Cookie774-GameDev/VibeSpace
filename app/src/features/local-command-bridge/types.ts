import type {
  InstantCommand,
  InstantCommandExecutionContext,
} from '@/features/instant-command/types';
import type {
  InstantCommandReceipt,
  InstantCommandReceiptStatus,
} from '@/features/instant-command/receipt';

export type LocalCommandPath = 'exact' | 'local-frame' | 'local-typo';

export type LocalCommandClassification = 'command_only' | 'llm_only' | 'both' | 'ambiguous';

export type LocalTextSpan = Readonly<{
  start: number;
  end: number;
}>;

export type LocalCommandSlots = Readonly<Record<string, unknown>>;

export type LocalDetectedCommand = Readonly<{
  id: string;
  confidence: number;
  source: string;
  sourceStart: number;
  sourceEnd: number;
  slots: LocalCommandSlots;
  path: LocalCommandPath;
}>;

export type LocalAmbiguousItem = Readonly<{
  source: string;
  sourceStart: number;
  sourceEnd: number;
  reason: string;
}>;

export type LocalRouteMetrics = Readonly<{
  candidateClauses: number;
  rejectedClauses: number;
  correctedTokens: number;
  /** Absent on the frozen router's exact/empty-input fast path. */
  suppressedControlClauses?: number;
  fastPath: boolean;
}>;

export type LocalRouteResult = Readonly<{
  commands: readonly LocalDetectedCommand[];
  residual: string;
  classification: LocalCommandClassification;
  ambiguous: readonly LocalAmbiguousItem[];
  metrics: LocalRouteMetrics;
}>;

export type LocalCommandAdaptation =
  | Readonly<{
      status: 'mapped';
      command: InstantCommand;
    }>
  | Readonly<{
      status: 'unsupported';
      reason: 'unsupported_authority' | 'invalid_slots';
    }>;

export type LocalBridgeExecutionContext = InstantCommandExecutionContext;

export type LocalBridgeReceiptStatus = InstantCommandReceiptStatus;

export type LocalBridgeExecution = Readonly<{
  detected: LocalDetectedCommand;
  command: InstantCommand;
  correlationId: string;
  receipt: InstantCommandReceipt;
}>;

export type LocalBridgeInput = Readonly<{
  text: string;
  interactionId: string;
  context: LocalBridgeExecutionContext;
}>;

export type LocalBridgeResult = Readonly<{
  originalText: string;
  modelText: string;
  detectedCommands: readonly LocalDetectedCommand[];
  executableCommands: readonly LocalDetectedCommand[];
  unsupportedCommands: readonly LocalDetectedCommand[];
  unexecutedCommands: readonly LocalDetectedCommand[];
  receipts: readonly InstantCommandReceipt[];
  executions: readonly LocalBridgeExecution[];
  localActionContext?: string;
  commandOnly: boolean;
  holdModel: boolean;
  classification: LocalCommandClassification;
  interactionId: string;
}>;
