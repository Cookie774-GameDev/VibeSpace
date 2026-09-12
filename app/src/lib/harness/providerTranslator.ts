import { HarnessError } from './errors';
import type { HarnessProvider } from './types';

export function resolveOpenCodeProvider(
  providerId: string,
  providers: readonly HarnessProvider[],
): HarnessProvider {
  const target = providerId === 'local' ? 'ollama' : providerId;
  const provider = providers.find((candidate) => candidate.id === target);
  if (!provider) {
    throw new HarnessError({
      code: 'PROVIDER_NOT_CONFIGURED',
      message: `Provider "${providerId}" is not available through OpenCode.`,
      repair: 'Connect this provider or select an available provider.',
      recoverable: true,
    });
  }
  return provider;
}
