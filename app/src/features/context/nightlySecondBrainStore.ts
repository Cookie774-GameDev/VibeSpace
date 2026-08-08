import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { safeLocalStorage } from '@/lib/persistence/safeLocalStorage';
import {
  DEFAULT_SECOND_BRAIN_CONFIG,
  type SecondBrainConfig,
  type SecondBrainRun,
  type SecondBrainSourceKind,
} from './nightlySecondBrain';

interface NightlySecondBrainState {
  config: SecondBrainConfig;
  runs: SecondBrainRun[];
  setEnabled(enabled: boolean): void;
  setMode(mode: SecondBrainConfig['mode']): void;
  setModel(model: SecondBrainConfig['model']): void;
  setCloudPrivatePermission(enabled: boolean): void;
  setSourceEnabled(kind: SecondBrainSourceKind, enabled: boolean): void;
  recordRun(run: SecondBrainRun): void;
}

export const useNightlySecondBrainStore = create<NightlySecondBrainState>()(
  persist(
    (set) => ({
      config: {
        ...DEFAULT_SECOND_BRAIN_CONFIG,
        sources: { ...DEFAULT_SECOND_BRAIN_CONFIG.sources },
      },
      runs: [],
      setEnabled: (enabled) =>
        set((state) => ({ config: { ...state.config, enabled, scheduleHour: 2 } })),
      setMode: (mode) => set((state) => ({ config: { ...state.config, mode } })),
      setModel: (model) => set((state) => ({ config: { ...state.config, model } })),
      setCloudPrivatePermission: (allowPrivateDataToCloud) =>
        set((state) => ({ config: { ...state.config, allowPrivateDataToCloud } })),
      setSourceEnabled: (kind, enabled) =>
        set((state) => ({
          config: {
            ...state.config,
            sources: { ...state.config.sources, [kind]: enabled },
          },
        })),
      recordRun: (run) =>
        set((state) => ({
          runs: [run, ...state.runs.filter((item) => item.id !== run.id)].slice(0, 30),
        })),
    }),
    {
      name: 'vibespace-nightly-second-brain-v1',
      storage: createJSONStorage(() => safeLocalStorage),
      version: 2,
      partialize: (state) => ({ config: state.config, runs: state.runs }),
      merge: (persisted, current) => {
        const value = persisted as Partial<NightlySecondBrainState> | undefined;
        const config = value?.config;
        const storedModel = config?.model;
        const model =
          storedModel &&
          typeof storedModel.provider === 'string' &&
          storedModel.provider &&
          typeof storedModel.modelId === 'string' &&
          storedModel.modelId
            ? storedModel
            : null;
        return {
          ...current,
          config: {
            ...DEFAULT_SECOND_BRAIN_CONFIG,
            ...(config ?? {}),
            scheduleHour: 2,
            model,
            sources: {
              ...DEFAULT_SECOND_BRAIN_CONFIG.sources,
              ...(config?.sources ?? {}),
            },
          },
          runs: Array.isArray(value?.runs) ? value.runs.slice(0, 30) : [],
        };
      },
    },
  ),
);
