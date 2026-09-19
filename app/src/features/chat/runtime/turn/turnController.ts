import { acceptTurn, publishTurnError, publishTurnEvent } from './turnStore';
import type { ProviderErrorDetails } from '@/lib/ai/providerError';
import type { TurnContextPlan, TurnIdentity, TurnProviderBinding } from './turnTypes';

export function beginCanonicalTurn(
  identity: TurnIdentity,
  options: { at?: number; cancellationKey?: string } = {},
) {
  return acceptTurn(identity, options.at ?? Date.now(), options.cancellationKey);
}

export function bindCanonicalTurnProvider(
  identity: Pick<TurnIdentity, 'accountId' | 'runId'>,
  provider: TurnProviderBinding,
  at = Date.now(),
) {
  return publishTurnEvent(identity, { type: 'provider.bound', provider, at });
}

export function bindCanonicalContextPlan(
  identity: Pick<TurnIdentity, 'accountId' | 'runId'>,
  plan: TurnContextPlan,
  at = Date.now(),
) {
  return publishTurnEvent(identity, { type: 'turn.context_planned', plan, at });
}

export function appendCanonicalReasoning(
  identity: Pick<TurnIdentity, 'accountId' | 'runId'>,
  text: string,
  mode?: 'append' | 'replace',
  at = Date.now(),
) {
  return publishTurnEvent(identity, {
    type: 'reasoning.delta',
    text,
    ...(mode ? { mode } : {}),
    at,
  });
}

export function failCanonicalTurn(
  identity: Pick<TurnIdentity, 'accountId' | 'runId'>,
  error: Readonly<ProviderErrorDetails>,
  at = Date.now(),
) {
  return publishTurnError(identity, error, at);
}
