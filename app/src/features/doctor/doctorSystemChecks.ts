import type { VibeSpaceDoctorSubsystemCheck } from './vibeSpaceDoctor';

class DoctorDeadlineError extends Error {}

export async function withDoctorDeadline<T>(
  run: () => PromiseLike<T> | T,
  timeoutMs = 20_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(run),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DoctorDeadlineError()), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runDoctorSystemChecks(
  checks: readonly {
    label: string;
    run():
      | string
      | { ok: boolean; detail: string }
      | Promise<string | { ok: boolean; detail: string }>;
  }[],
  timeoutMs = 10_000,
): Promise<VibeSpaceDoctorSubsystemCheck[]> {
  return Promise.all(
    checks.map(async ({ label, run }) => {
      try {
        const result = await withDoctorDeadline(run, timeoutMs);
        return typeof result === 'string'
          ? { label, ok: true, detail: result }
          : { label, ...result };
      } catch (error) {
        return {
          label,
          ok: false,
          detail:
            error instanceof DoctorDeadlineError
              ? 'Check timed out; readiness remains unverified'
              : 'Check failed; readiness remains unverified',
        };
      }
    }),
  );
}

/** Read-only capability checks. Never place a call, send a message, or create/restore a backup. */
export async function runDefaultDoctorSystemChecks(): Promise<VibeSpaceDoctorSubsystemCheck[]> {
  const [{ getSupabaseClient }, { telemetryConsentStore }, { useJarvisLearningStore }, calls] =
    await Promise.all([
      import('@/lib/supabase'),
      import('@/features/telemetry/telemetryConsent'),
      import('@/features/jarvis-memory/learningStore'),
      import('@/features/call/config'),
    ]);
  const client = getSupabaseClient();
  const account = client
    ? withDoctorDeadline(async () => {
        const session = await client.auth.getSession();
        if (session.error) throw new Error();
        if (!session.data.session) return null;
        const verified = await client.auth.getUser();
        if (verified.error || verified.data.user?.id !== session.data.session.user.id)
          throw new Error();
        return verified.data.user;
      }, 8_000)
    : Promise.resolve(null);
  // Consumers below attach immediately; a failed session never becomes a background rejection.
  const phone = calls.checkCallCloudReadiness(calls.callCloudUrl());
  return runDoctorSystemChecks([
    {
      label: 'Cloud account',
      run: async () => {
        if (!client)
          return {
            ok: false,
            detail: 'Not configured; local-only mode (cloud sign-in not tested)',
          };
        return (await account)
          ? 'Authenticated session verified with Supabase'
          : { ok: false, detail: 'Signed out; cloud checks require sign-in' };
      },
    },
    {
      label: 'Encrypted cloud backup',
      run: async () => {
        const user = await account;
        if (!client || !user)
          return { ok: false, detail: 'Not checked; sign in to inspect cloud backup access' };
        if (!globalThis.crypto?.subtle) throw new Error();
        const result = await client
          .from('app_sync_records')
          .select('row_id', { count: 'exact', head: true })
          .eq('user_id', user.id)
          .eq('table_name', 'encrypted_workspace_backup_v1')
          .eq('row_id', 'latest');
        if (result.error) throw new Error();
        return `${result.count ? 'Backup present' : 'No cloud backup yet'}; read access verified. Upload and restore not exercised`;
      },
    },
    {
      label: 'Calls / phone messaging',
      run: async () => {
        const state = await phone;
        if (state.state === 'missing')
          return {
            ok: false,
            detail: 'Not configured; set the phone backend URL before live calls or messages',
          };
        if (state.state !== 'ready' && state.state !== 'partial') throw new Error();
        if (state.state === 'partial')
          return {
            ok: false,
            detail: `Backend transport setup incomplete: ${Object.entries(state.transports)
              .filter(([, ready]) => !ready)
              .map(([name]) => name)
              .join(', ')}`,
          };
        return 'Backend reports configured transports; call and message delivery not exercised';
      },
    },
    {
      label: 'Call Anyone service',
      run: async () => {
        if (!client || !(await account))
          return { ok: false, detail: 'Not checked; sign in to inspect call service access' };
        const result = await client.functions.invoke('third-party-call', {
          body: { action: 'list-scheduled' },
        });
        if (result.error || !Array.isArray(result.data?.schedules))
          return {
            ok: false,
            detail:
              'Unavailable; verify third-party-call deployment and account access. No call placed',
          };
        return 'Authenticated schedule read succeeded; call execution not exercised';
      },
    },
    {
      label: 'Message service',
      run: async () => {
        if (!client || !(await account))
          return { ok: false, detail: 'Not checked; sign in to inspect message service access' };
        const result = await client.functions.invoke('get-message-usage', { method: 'GET' });
        if (result.error || typeof result.data?.company_messaging_available !== 'boolean')
          return {
            ok: false,
            detail:
              'Unavailable; verify get-message-usage deployment and account access. No message sent',
          };
        return result.data.company_messaging_available
          ? 'Authenticated usage read succeeded; message delivery not exercised'
          : {
              ok: false,
              detail:
                'Usage read succeeded; company messaging credits unavailable. No message sent',
            };
      },
    },
    {
      label: 'Privacy',
      run: () => {
        const { consent } = telemetryConsentStore.getSnapshot();
        const enabled = [consent.productUsage, consent.diagnostics, consent.toolOutcomes].filter(Boolean).length;
        return `Optional telemetry ${enabled ? `${enabled} of 3 classes enabled` : 'disabled'}; local consent read, no preference changed`;
      },
    },
    {
      label: 'Learning storage',
      run: () => {
        const state = useJarvisLearningStore.getState();
        const profile = state.profiles[state.activeAccountId];
        if (!profile || profile.accountId !== state.activeAccountId || state.lastError)
          throw new Error();
        return `Account-scoped settings readable; learning ${profile.enabled ? 'enabled' : 'paused'}. Execution not tested`;
      },
    },
  ]);
}
