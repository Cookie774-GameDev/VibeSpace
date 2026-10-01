import { resolveOpenCodeSelection, type OpenCodeSelectionInput } from './providerReconciliation';
import type { HarnessModelSelection, HarnessProvider } from './types';

export function resolveOpenCodeModelSelection(input: {
  providerId: string;
  modelId: string;
  connectionId?: string;
  runtimeProviderId?: string;
  providers: readonly HarnessProvider[];
}): HarnessModelSelection {
  const { providers, ...selection } = input;
  return resolveOpenCodeSelection(selection as OpenCodeSelectionInput, providers);
}
