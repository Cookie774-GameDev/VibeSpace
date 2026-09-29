import { getSupabaseClient } from '@/lib/supabase/client';
import { createSingleFlightRunner } from '@/stability/singleFlight';
import { createThirdPartyCallClient } from './client';
import type { ScheduledThirdPartyCall } from './types';

type ScheduledCallClient = Pick<
  ReturnType<typeof createThirdPartyCallClient>,
  'listScheduled' | 'dispatchScheduled'
>;

export interface ScheduledCallRunner {
  runNow(): Promise<void>;
  stop(): void;
}

export function createScheduledCallRunner(
  client: ScheduledCallClient,
  options: {
    intervalMs?: number;
    now?: () => number;
    onError?: (error: unknown, schedule?: ScheduledThirdPartyCall) => void;
  } = {},
): ScheduledCallRunner {
  const intervalMs = Math.max(5_000, options.intervalMs ?? 30_000);
  const now = options.now ?? Date.now;
  let stopped = false;
  const flight = createSingleFlightRunner(async () => {
    let schedules: ScheduledThirdPartyCall[];
    try {
      schedules = await client.listScheduled();
    } catch (error) {
      options.onError?.(error);
      return;
    }
    if (stopped) return;
    const due = schedules.filter(
      (schedule) =>
        (schedule.status === 'scheduled' || schedule.status === 'dispatching') &&
        new Date(schedule.scheduledFor).getTime() <= now(),
    );
    for (const schedule of due) {
      if (stopped) return;
      try {
        await client.dispatchScheduled(schedule.id, schedule.revision);
      } catch (error) {
        options.onError?.(error, schedule);
      }
    }
  });
  const timer = window.setInterval(() => void flight.run(), intervalMs);

  return {
    runNow: () => flight.run(),
    stop: () => {
      stopped = true;
      flight.stop();
      window.clearInterval(timer);
    },
  };
}

export function startScheduledCallRunner(): () => void {
  const supabase = getSupabaseClient();
  if (!supabase) return () => undefined;
  const callClient = createThirdPartyCallClient(supabase);
  const runner = createScheduledCallRunner(
    {
      listScheduled: async () => {
        const { data, error } = await supabase.auth.getSession();
        if (error || !data.session?.user.id) return [];
        return callClient.listScheduled();
      },
      dispatchScheduled: callClient.dispatchScheduled,
    },
    {
      onError: (error, schedule) => {
        console.warn(
          schedule
            ? `[scheduled-call] ${schedule.id} remains server-authoritative after dispatch failure`
            : '[scheduled-call] schedule refresh unavailable',
          error,
        );
      },
    },
  );
  void runner.runNow();
  return () => runner.stop();
}
