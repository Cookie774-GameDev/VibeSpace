export const JEV_INPUT_COST_PER_MILLION = 0.042;

export type JevUsageRecord = Readonly<{
  id: string;
  accountId: string;
  workspaceId: string;
  projectId?: string | null;
  missionId: string | null;
  targetId: string | null;
  model: string;
  version?: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  status: 'ok' | 'error' | 'unavailable';
  reason: string;
  event?: 'event' | 'sweep' | 'pre-send-quality' | 'learning-gate' | 'wake';
  recordedAt: number;
  costUsd: number | null;
  costProvenance: 'provider-reported' | 'estimated' | 'unavailable';
}>;

function boundedReason(value: string): string {
  return value.trim().replace(/[\r\n\t]+/gu, ' ').slice(0, 160);
}

export function buildJevUsageRecord(
  input: Omit<JevUsageRecord, 'costUsd' | 'costProvenance'> & {
    providerCostUsd?: number | null;
  },
): JevUsageRecord {
  const { providerCostUsd: providedCostUsd, ...recordInput } = input;
  const inputTokens = typeof input.inputTokens === 'number' && Number.isSafeInteger(input.inputTokens) && input.inputTokens >= 0
    ? input.inputTokens
    : null;
  const outputTokens = typeof input.outputTokens === 'number' && Number.isSafeInteger(input.outputTokens) && input.outputTokens >= 0
    ? input.outputTokens
    : null;
  const latencyMs = Number.isFinite(input.latencyMs) && input.latencyMs >= 0 ? Math.floor(input.latencyMs) : 0;
  const providerCostUsd = typeof providedCostUsd === 'number' && Number.isFinite(providedCostUsd) && providedCostUsd >= 0
    ? providedCostUsd
    : null;
  const costUsd = providerCostUsd ?? (inputTokens === null ? null : (inputTokens / 1_000_000) * JEV_INPUT_COST_PER_MILLION);
  const costProvenance = providerCostUsd !== null
    ? 'provider-reported' as const
    : costUsd === null
      ? 'unavailable' as const
      : 'estimated' as const;
  return Object.freeze({
    ...recordInput,
    reason: boundedReason(input.reason),
    inputTokens,
    outputTokens,
    latencyMs,
    costUsd,
    costProvenance,
  });
}
