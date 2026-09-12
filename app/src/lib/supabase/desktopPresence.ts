import type { Json } from './types';

const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const SAFE_STATUS = new Set([
  'active',
  'idle',
  'open',
  'running',
  'queued',
  'blocked',
  'done',
  'failed',
  'stopped',
  'unknown',
]);
const SAFE_PROVIDER = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface PresenceItemInput {
  readonly id: string;
  readonly name: string;
  readonly status: string;
}

export interface DesktopPresenceInput {
  readonly deviceId: string;
  readonly displayName: string;
  readonly appVersion: string;
  readonly terminals: readonly PresenceItemInput[];
  readonly chats: readonly PresenceItemInput[];
  readonly agentJobs: readonly PresenceItemInput[];
  readonly activeRuntime: string | null;
  readonly providerUsage: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly backgroundTaskCount: number;
  readonly recentSyncAt: string | null;
}

export interface DesktopPresenceSnapshot extends Omit<
  DesktopPresenceInput,
  'terminals' | 'chats' | 'agentJobs' | 'providerUsage' | 'backgroundTaskCount'
> {
  readonly terminals: readonly PresenceItemInput[];
  readonly chats: readonly PresenceItemInput[];
  readonly agentJobs: readonly PresenceItemInput[];
  readonly providerUsage: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly backgroundTaskCount: number;
}

interface PresenceRpcClient {
  rpc(
    name: string,
    params: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
}

function safeText(value: unknown, maxLength: number): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxLength);
}

function safeItems(items: readonly PresenceItemInput[]): readonly PresenceItemInput[] {
  return items.slice(0, 50).flatMap((item) => {
    const id = safeText(item.id, 128);
    const name = safeText(item.name, 120);
    if (!id || !name) return [];
    const normalizedStatus = safeText(item.status, 24).toLowerCase();
    return [
      {
        id,
        name,
        status: SAFE_STATUS.has(normalizedStatus) ? normalizedStatus : 'unknown',
      },
    ];
  });
}

function safeUsage(
  usage: DesktopPresenceInput['providerUsage'],
): DesktopPresenceSnapshot['providerUsage'] {
  const result: Record<string, Record<string, number>> = {};
  for (const [provider, metrics] of Object.entries(usage).slice(0, 20)) {
    if (!SAFE_PROVIDER.test(provider)) continue;
    const safeMetrics: Record<string, number> = {};
    for (const [metric, value] of Object.entries(metrics).slice(0, 12)) {
      if (!SAFE_PROVIDER.test(metric) || !Number.isFinite(value)) continue;
      safeMetrics[metric] = Math.max(0, Math.min(value, 1_000_000_000));
    }
    result[provider] = safeMetrics;
  }
  return result;
}

export function sanitizeDesktopPresence(input: DesktopPresenceInput): DesktopPresenceSnapshot {
  if (!DEVICE_ID.test(input.deviceId)) throw new Error('Invalid desktop device id.');
  const displayName = safeText(input.displayName, 80);
  const appVersion = safeText(input.appVersion, 40);
  if (!displayName || !appVersion) throw new Error('Invalid desktop device metadata.');

  return {
    deviceId: input.deviceId,
    displayName,
    appVersion,
    terminals: safeItems(input.terminals),
    chats: safeItems(input.chats),
    agentJobs: safeItems(input.agentJobs),
    activeRuntime: input.activeRuntime ? safeText(input.activeRuntime, 120) || null : null,
    providerUsage: safeUsage(input.providerUsage),
    backgroundTaskCount: Math.max(0, Math.min(Math.trunc(input.backgroundTaskCount || 0), 1000)),
    recentSyncAt:
      input.recentSyncAt && Number.isFinite(Date.parse(input.recentSyncAt))
        ? new Date(input.recentSyncAt).toISOString()
        : null,
  };
}

export async function publishDesktopPresence(
  client: PresenceRpcClient,
  expectedUserId: string,
  input: DesktopPresenceInput,
): Promise<boolean> {
  const normalizedUserId = expectedUserId.trim();
  if (!USER_ID.test(normalizedUserId)) throw new Error('Invalid desktop account id.');
  const snapshot = sanitizeDesktopPresence(input);
  const { data, error } = await client.rpc('publish_desktop_presence', {
    p_expected_user_id: normalizedUserId,
    p_device_id: snapshot.deviceId,
    p_display_name: snapshot.displayName,
    p_app_version: snapshot.appVersion,
    p_active_terminals: snapshot.terminals as unknown as Json,
    p_active_chats: snapshot.chats as unknown as Json,
    p_active_agent_jobs: snapshot.agentJobs as unknown as Json,
    p_active_runtime: snapshot.activeRuntime,
    p_provider_usage: snapshot.providerUsage as unknown as Json,
    p_background_task_count: snapshot.backgroundTaskCount,
    p_recent_sync_at: snapshot.recentSyncAt,
  });
  if (error) throw new Error('Desktop presence is unavailable.');
  return data === true;
}

export async function markDesktopPresenceOffline(
  client: PresenceRpcClient,
  expectedUserId: string,
  deviceId: string,
): Promise<boolean> {
  const normalizedUserId = expectedUserId.trim();
  if (!USER_ID.test(normalizedUserId)) throw new Error('Invalid desktop account id.');
  if (!DEVICE_ID.test(deviceId)) throw new Error('Invalid desktop device id.');
  const { data, error } = await client.rpc('mark_desktop_presence_offline', {
    p_expected_user_id: normalizedUserId,
    p_device_id: deviceId,
  });
  if (error) throw new Error('Desktop presence is unavailable.');
  return data === true;
}
