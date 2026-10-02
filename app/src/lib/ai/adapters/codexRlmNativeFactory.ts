// STAGING ONLY: requires new native commands; no generic cli_bridge_start fallback.
import { createCodexRlmExecChildRunner, type CodexRlmExecDependencies } from './codexRlmExecChild';
import type { RlmChildRequest } from '@/features/context/rlmRuntime';
import type { CliBridgeEvent } from '@/lib/ai/adapters/cliBridge';

type ParentBinding = Readonly<{ caller: string; owner: string; generation: string }>;
type Runtime = Awaited<ReturnType<CodexRlmExecDependencies['parentRuntime']>>;
type Capability = Awaited<ReturnType<CodexRlmExecDependencies['capability']>>;
export interface NativeChildAuthority {
  authorityHandle: string;
  parent: ParentBinding;
  runtime: Runtime;
  capability: Capability;
  accountHash: string;
  sameUniqueAccount: boolean;
}
export interface NativeCodexChildCommands {
  // Native validates active caller/owner/generation; prepares exclusive empty cwd,
  // proves matching unique account, and issues one-use authority after exact
  // pinned binary/config loopback controls. Authenticated model acceptance
  // remains a separate native validation receipt.
  prepare(input: ParentBinding): Promise<NativeChildAuthority>;
  // Fixed native policy reconstructs args, verifies executable SHA/generation,
  // strips provider override env, preserves parent auth home, then uses the
  // independent CLI supervisor. No arbitrary args/cwd/executable input exists.
  stream(input: { authorityHandle: string; requestId: string; prompt: string;
    timeoutMs: number; outputLimitBytes: number }): AsyncIterable<CliBridgeEvent>;
  cancel(requestId: string): Promise<boolean>;
  revoke(authorityHandle: string): Promise<void>;
}
export function createNativeBoundCodexRlmChild(
  native: NativeCodexChildCommands,
  currentParent: (request: RlmChildRequest) => Promise<ParentBinding>,
  requestId: () => string,
) {
  let prepared: NativeChildAuthority | undefined;
  let admitted = false;
  const run = createCodexRlmExecChildRunner({
    async parentRuntime(request) {
      const parent = await currentParent(request);
      const proof = await native.prepare(parent);
      if (proof.parent.caller !== parent.caller || proof.parent.owner !== parent.owner ||
          proof.parent.generation !== parent.generation || !proof.sameUniqueAccount ||
          !/^[a-f0-9]{64}$/iu.test(proof.accountHash) ||
          !/^codex-rlm-authority-[A-Za-z0-9_-]{20,}$/u.test(proof.authorityHandle)) {
        await native.revoke(proof.authorityHandle);
        throw Error('rlm_native_authority_unverified');
      }
      prepared = proof;
      return proof.runtime;
    },
    async capability() {
      if (!prepared) throw Error('rlm_native_authority_unavailable');
      return prepared.capability;
    },
    async *stream(request) {
      const proof = prepared;
      if (!proof || request.executableId !== proof.runtime.executableId ||
          request.cwd !== proof.runtime.isolatedWorkingDirectory || !request.stdin) {
        throw Error('rlm_native_authority_unavailable');
      }
      // Generic bridge args are deliberately not forwarded across native IPC.
      yield* native.stream({ authorityHandle: proof.authorityHandle,
        requestId: request.requestId, prompt: request.stdin,
        timeoutMs: request.timeoutMs, outputLimitBytes: request.outputLimitBytes });
    },
    cancel: native.cancel.bind(native), requestId,
  });
  return async (request: RlmChildRequest) => {
    if (admitted) throw Error('rlm_child_resource_busy');
    admitted = true;
    try { return await run(request); }
    finally {
      const proof = prepared; prepared = undefined;
      try { if (proof) await native.revoke(proof.authorityHandle); }
      finally { admitted = false; }
    }
  };
}
