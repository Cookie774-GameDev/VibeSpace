// STAGING ONLY. Register from the active Codex adapter after native identity validation.
import type { RlmChildRequest } from '@/features/context/rlmRuntime';
import type { ExecutionIdentity } from '@/features/context/gateway/contextGatewayContracts';
type Frame = Readonly<Record<string, unknown>>;
export type LiveCodexParent = Readonly<{
  caller: 'main' | 'workbench-main'; owner: string; generation: string;
  identity: Readonly<ExecutionIdentity>; signal?: AbortSignal;
  active(): boolean;
  accountRead(): Promise<Frame>;
}>;
const parents = new Map<string, LiveCodexParent>();
const fields = ['transportConnectionId','transportAdapterId','upstreamProviderId',
  'upstreamModelId','providerQualifiedModelId','authBillingRoute','effort','fastVariant','catalogRevision','observedProviderIdentity'] as const;
export function registerLiveCodexRlmParent(parent: LiveCodexParent): () => void {
  if (!parent.generation || parent.identity.catalogRevision !== parent.generation ||
      parents.has(parent.generation) || parent.identity.transportConnectionId !== 'openai-codex' ||
      parent.identity.upstreamProviderId !== 'openai' || parent.identity.authBillingRoute !== 'codex-cli-session' ||
      parent.identity.providerQualifiedModelId !== `openai/${parent.identity.upstreamModelId}` ||
      parent.identity.observedProviderIdentity !== parent.identity.providerQualifiedModelId) {
    throw Error('rlm_parent_binding_invalid');
  }
  const bound = Object.freeze({ ...parent, identity: Object.freeze({ ...parent.identity }) });
  parents.set(parent.generation, bound);
  return () => { if (parents.get(parent.generation) === bound) parents.delete(parent.generation); };
}
export async function readLiveCodexRlmParent(request: RlmChildRequest) {
  const identity = request.executionIdentity;
  const parent = parents.get(identity.catalogRevision);
  if (!parent || fields.some(key => parent.identity[key] !== identity[key]) ||
      parent.signal?.aborted || request.signal.aborted || !parent.active()) {
    throw Error('rlm_parent_binding_unavailable');
  }
  // Uses the live parent's control request map and reader. Raw account data is
  // discarded here; the native correlated observer alone retains its opaque hash.
  const frame = await parent.accountRead();
  const result = frame.result as { account?: { type?: unknown; email?: unknown }; requiresOpenaiAuth?: unknown } | undefined;
  if (!result || result.account?.type !== 'chatgpt' || typeof result.account.email !== 'string' ||
      !result.account.email.trim() || result.requiresOpenaiAuth !== true) {
    throw Error('rlm_parent_subscription_unverified');
  }
  if (parents.get(parent.generation) !== parent || parent.signal?.aborted ||
      request.signal.aborted || !parent.active()) throw Error('rlm_parent_binding_changed');
  return Object.freeze({ caller: parent.caller, owner: parent.owner, generation: parent.generation });
}
