import type { JarvisDexie } from '../db/database';
import type { JevUsageRecordRow } from '../db/schema';
import { buildJevUsageRecord } from './usage';
import type { JevUsage } from './types';

export type JevUsageEventWriter = (
  input: Readonly<{
    model: string;
    usage: JevUsage;
    latencyMs: number;
    status: 'ok' | 'error';
  }>,
) => void;

/**
 * Writes only bounded, scoped Jev observations. The callback is intentionally
 * fire-and-forget so a local ledger failure cannot turn a valid decision into
 * a CAO failure.
 */
export function createJevUsageEventWriter(input: {
  database: JarvisDexie;
  accountId: string;
  workspaceId: string;
  projectId?: string | null;
  missionId?: string | null;
  targetId?: string | null;
  event?: JevUsageRecordRow['event'] | (() => JevUsageRecordRow['event']);
  now?: () => number;
  id?: () => string;
}): JevUsageEventWriter {
  const now = input.now ?? Date.now;
  const id = input.id ?? (() => crypto.randomUUID());
  return (usage) => {
    try {
      const event = typeof input.event === 'function' ? input.event() : input.event;
      const record = buildJevUsageRecord({
        id: id(),
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        projectId: input.projectId ?? null,
        missionId: input.missionId ?? null,
        targetId: input.targetId ?? null,
        model: usage.model,
        inputTokens: usage.usage.inputTokens,
        outputTokens: usage.usage.outputTokens,
        latencyMs: usage.latencyMs,
        status: usage.status,
        reason: 'cao_sentinel_observation',
        event: event ?? 'sweep',
        recordedAt: now(),
        providerCostUsd: usage.usage.costUsd,
      });
      const row: JevUsageRecordRow = {
        id: record.id,
        accountId: record.accountId,
        workspaceId: record.workspaceId,
        projectId: record.projectId ?? null,
        missionId: record.missionId,
        targetId: record.targetId,
        model: record.model,
        version: record.version ?? null,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        latencyMs: record.latencyMs,
        status: record.status,
        reason: record.reason,
        event: record.event ?? 'sweep',
        recordedAt: record.recordedAt,
        costUsd: record.costUsd,
        costProvenance: record.costProvenance,
      };
      void input.database.jev_usage_records.put(row).catch(() => undefined);
    } catch {
      // Local telemetry is observational and must not affect CAO authority.
    }
  };
}
