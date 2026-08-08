import { useEffect } from 'react';
import { NightlySecondBrainScheduler } from './nightlySecondBrainScheduler';
import { runNightlySecondBrain } from './nightlySecondBrainRuntime';
import { useNightlySecondBrainStore } from './nightlySecondBrainStore';

export function NightlySecondBrainHost() {
  useEffect(() => {
    const scheduler = new NightlySecondBrainScheduler({
      now: () => new Date(),
      lastScheduledFor: () =>
        useNightlySecondBrainStore
          .getState()
          .runs.reduce<
            number | undefined
          >((latest, run) => (latest === undefined || run.scheduledFor > latest ? run.scheduledFor : latest), undefined),
      run: async (scheduledFor) => {
        const config = useNightlySecondBrainStore.getState().config;
        if (!config.enabled || !config.model) return;
        await runNightlySecondBrain(scheduledFor);
      },
      setTimer: (callback, delay) => globalThis.setTimeout(callback, delay),
      clearTimer: (timer) => globalThis.clearTimeout(timer),
    });
    const resume = () => {
      if (document.visibilityState === 'visible') scheduler.resume();
    };
    scheduler.start();
    const unsubscribe = useNightlySecondBrainStore.subscribe((state, previous) => {
      if (state.config !== previous.config) scheduler.resume();
    });
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('focus', resume);
    return () => {
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('focus', resume);
      unsubscribe();
      scheduler.stop();
    };
  }, []);
  return null;
}
