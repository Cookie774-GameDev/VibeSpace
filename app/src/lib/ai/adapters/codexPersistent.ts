import { createCodexControlBridge } from './codexControlBridge';
import { appActivityLog } from '@/lib/diagnostics/appActivityLog';
import { codexTurnLease } from './codexTurnLease';
import { CODEX_CONTEXT_TOOL, createCodexContextTool, type CodexContextToolBridge } from './codexContextTool';
import { resolveCodexWorkingDirectory } from './codexWorkingDirectory';
import {
  nativeCodexFrames,
  startNativeCodexAppServer,
  stopNativeCodexAppServer,
  writeNativeCodexFrame,
} from '@/lib/harness/codexNativeTransport';
import {
  buildCodexModelListRequest,
  buildCodexThreadResumeRequest,
  buildCodexThreadPolicyUpdateRequest,
  buildCodexThreadStartRequest,
  buildCodexTurnInterruptRequest,
  buildCodexTurnStartRequest,
  validateCodexModelListResponse,
  validateCodexThreadStartResponse,
  type CodexBackendIdentity,
  type CodexExecutionMode,
} from './codexAppServerProtocol';
import {
  normalizeCodexAppServerMessage,
  normalizeCodexThreadBindingResponse,
} from './codexAppServer';
import { findCliExecutable } from './cliBridge';
import type { DetectedExecutable } from './cliBridge';
import type { ProviderAdapter, ProviderEvent, ProviderRequest, UsageSnapshot } from './types';
import { codexRuntimeManager, type CodexRuntimeManager } from '@/lib/harness/codexRuntimeManager';

type NativeFrame = Record<string, unknown>;

async function prepare<T>(request: ProviderRequest, phase: string, action: () => Promise<T>): Promise<T> {
  // Record phase timing without copying native frames, policies, paths or credentials.
  let result!: T;
  await appActivityLog.trace(`model.prepare.codex.${phase}`, {
    chatId: request.chatId, requestId: request.requestId, modelId: request.modelId,
  }, async () => { result = await action(); });
  return result;
}

export interface CodexPersistentDependencies {
  contextTool?(request: ProviderRequest): Promise<CodexContextToolBridge | null>;
  workingDirectory?(selected: string | undefined): Promise<string>;
  findExecutable(): Promise<Readonly<{ executableId: string }> | undefined>;
  start(
    executableId: string,
    ownerId: string,
    modelId: string,
  ): Promise<Readonly<{ generation: string }>>;
  frames(
    generation: string,
    signal?: AbortSignal,
  ): Readonly<{
    stream: AsyncIterable<NativeFrame>;
    ready: Promise<void>;
  }>;
  write(generation: string, message: NativeFrame): Promise<void>;
  stop(generation: string): Promise<boolean>;
}

export interface CodexExecutableResolverDependencies {
  manager: Pick<CodexRuntimeManager, 'refresh' | 'getSnapshot'>;
  findSystem(): Promise<DetectedExecutable | undefined>;
}

const defaultResolverDependencies: CodexExecutableResolverDependencies = {
  manager: codexRuntimeManager,
  findSystem: () => findCliExecutable('codex'),
};

export async function resolveCodexExecutable(
  dependencies: CodexExecutableResolverDependencies = defaultResolverDependencies,
): Promise<Readonly<{ executableId: string }> | DetectedExecutable | undefined> {
  try {
    // Native launch revalidates the registered executable and seals OpenCodex.
    // Repeating full managed discovery here adds cold-start work to every turn.
    const ready = dependencies.manager.getSnapshot();
    if (ready.kind === 'ready') {
      return Object.freeze({ executableId: ready.executableId });
    }
    await dependencies.manager.refresh();
    const managed = dependencies.manager.getSnapshot();
    if (managed.kind === 'ready') {
      return Object.freeze({ executableId: managed.executableId });
    }
  } catch {
    // The existing fingerprinted system scan remains an independent trusted authority.
  }
  return dependencies.findSystem();
}

const defaultDependencies: CodexPersistentDependencies = {
  contextTool: createCodexContextTool,
  workingDirectory: resolveCodexWorkingDirectory,
  findExecutable: () => resolveCodexExecutable(),
  start: startNativeCodexAppServer,
  frames: (generation, signal) => {
    let subscribed!: () => void;
    const ready = new Promise<void>((resolve) => {
      subscribed = resolve;
    });
    return {
      stream: nativeCodexFrames(generation, signal, undefined, subscribed),
      ready,
    };
  },
  write: writeNativeCodexFrame,
  stop: stopNativeCodexAppServer,
};

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function promptText(request: Readonly<ProviderRequest>, newThread = false): string {
  return newThread ? request.historyPrompt?.trim() || request.prompt : request.prompt;
}

function developerInstructions(request: Readonly<ProviderRequest>): string {
  return [
    request.systemPrompt?.trim(),
    '## Codex native execution',
    'For coding work, use the available native file and command tools when the current mode permits them. Do not replace those tools with textual files.create, files.edit, or terminal action proposals.',
    'Native sandbox and approval rules remain authoritative. Ask and Plan remain read-only; never bypass a denied tool or approval through another connector.',
    'Textual VibeSpace action proposals are only for app operations without an available native tool. Finish the response after such a proposal so the chat can present its approval; do not wait for approval inside the active turn.',
  ].filter(Boolean).join('\n\n');
}

function effort(request: Readonly<ProviderRequest>): string | null {
  const value = request.reasoningEffort ?? request.runtimeSettings?.effort;
  if (!value || value === 'auto') return null;
  if (value === 'ultra') return 'xhigh';
  return value;
}

function createTurnUsageAccumulator() {
  const baseline = new Map<string, number | null>();
  return (usage: UsageSnapshot, frame: NativeFrame): UsageSnapshot => {
    const totals = recordOf(recordOf(recordOf(frame.params)?.tokenUsage)?.total);
    const result = { ...usage };
    for (const [key, source] of [
      ['inputTokens', 'inputTokens'], ['outputTokens', 'outputTokens'],
      ['totalTokens', 'totalTokens'], ['cacheReadTokens', 'cachedInputTokens'],
      ['cacheWriteTokens', 'cacheWriteInputTokens'], ['reasoningTokens', 'reasoningOutputTokens'],
    ] as const) {
      const total = totals?.[source];
      const last = usage[key]?.value;
      const valid = typeof total === 'number' && Number.isFinite(total) && total >= 0;
      if (!baseline.has(key)) {
        baseline.set(key, valid && last !== undefined && total >= last ? total - last : null);
      }
      const before = baseline.get(key);
      result[key] = valid && before !== null && before !== undefined && total >= before
        ? { value: total - before, provenance: 'provider-reported' }
        : { provenance: 'unavailable', reason: 'Codex did not report a complete turn counter.' };
    }
    return result;
  };
}

function executionMode(request: Readonly<ProviderRequest>): CodexExecutionMode {
  const mode = request.interactionMode ?? 'agent';
  if (mode === 'ask' || mode === 'plan') return { kind: mode };
  const cwd = request.workingDirectory;
  if (!cwd) throw new Error('Codex Agent mode requires an exact working directory.');
  if (request.accessLevel === 'read-only') return { kind: 'ask' };
  return {
    kind: 'agent',
    approvalPolicy: request.approveAllForRun ? 'never' : 'on-request',
    sandbox: {
      kind: 'workspace-write',
      writableRoots: [cwd],
      networkAccess: false,
    },
  };
}

function identity(request: Readonly<ProviderRequest>): CodexBackendIdentity {
  if (!request.modelId) throw new Error('Codex requires an exact selected model.');
  if (!request.workingDirectory) throw new Error('Codex requires an exact working directory.');
  return {
    modelProvider: 'openai',
    model: request.modelId,
    effort: effort(request),
    serviceTier: request.runtimeSettings?.fastMode === 'on' ? 'fast' : null,
    cwd: request.workingDirectory,
  };
}

function requestId(base: string, suffix: string): string {
  const normalized = base.replace(/[^A-Za-z0-9._:@/+/-]/gu, '_').slice(0, 220);
  if (!normalized) throw new Error('Codex request identity is invalid.');
  return normalized + '_' + suffix;
}

async function nextFrame(
  iterator: AsyncIterator<NativeFrame>,
  failure: string,
): Promise<NativeFrame> {
  const next = await iterator.next();
  if (next.done) throw new Error(failure);
  return next.value;
}

async function responseFrame(
  iterator: AsyncIterator<NativeFrame>,
  id: string,
): Promise<NativeFrame> {
  for (let count = 0; count < 4_096; count += 1) {
    const frame = await nextFrame(iterator, 'Codex app-server ended before its response.');
    if (frame.id === id) return frame;
    if (frame.method === 'error') throw new Error('Codex app-server rejected the request.');
  }
  throw new Error('Codex app-server response exceeded its safe event bound.');
}

async function validateModelCapability(
  generation: string,
  iterator: AsyncIterator<NativeFrame>,
  exactIdentity: Readonly<CodexBackendIdentity>,
  write: CodexPersistentDependencies['write'],
  baseRequestId: string,
): Promise<void> {
  let cursor: string | undefined;
  for (let page = 0; page < 32; page += 1) {
    const id = requestId(baseRequestId, 'model_' + String(page + 1));
    await write(generation, buildCodexModelListRequest({ requestId: id, cursor }));
    const validation = validateCodexModelListResponse(
      await responseFrame(iterator, id),
      id,
      exactIdentity,
    );
    if (validation.ok) return;
    if (validation.reason === 'next_page') {
      cursor = validation.cursor;
      continue;
    }
    throw new Error('Codex model capability mismatch: ' + validation.field + '.');
  }
  throw new Error('Codex model capability pagination exceeded its safe bound.');
}

async function* sendCodexRequest(
  request: ProviderRequest,
  dependencies: CodexPersistentDependencies,
  recoverImplicitThread = false,
  contextTool: CodexContextToolBridge | null = null,
): AsyncGenerator<ProviderEvent> {
  if (request.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
  if (request.connection.id !== 'openai-codex') {
    throw new Error('Codex backend requires the exact Codex connection.');
  }
  request = {
    ...request,
    workingDirectory: await prepare(request, 'directory', () =>
      (dependencies.workingDirectory ?? resolveCodexWorkingDirectory)(request.workingDirectory)),
  };
  if (request.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
  const mode = executionMode(request);
  const executable = await prepare(request, 'executable', () => dependencies.findExecutable());
  if (request.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
  if (!executable) throw new Error('Codex CLI is not installed.');
  const ownerId = request.chatId ?? request.requestId;
  if (!request.modelId) throw new Error('Codex requires an exact selected model.');
  const modelId = request.modelId;
  const { generation } = await prepare(request, 'start', () => dependencies.start(
    executable.executableId,
    ownerId,
    modelId,
  ));
  if (request.signal?.aborted) {
    await dependencies.stop(generation).catch(() => false);
    throw new DOMException('The request was aborted.', 'AbortError');
  }
  let iterator: AsyncIterator<NativeFrame> | undefined;
  let threadId: string | undefined;
  let turnId: string | undefined;
  let terminal = false;
  const controls = createCodexControlBridge(message => dependencies.write(generation, message), mode);
  let cancelPendingWaits!: () => void;
  const cancelled = new Promise<void>((resolve) => { cancelPendingWaits = resolve; });
  const abort = () => {
    // A stalled public projection must not retain this turn or its approval handles.
    controls.dispose();
    cancelPendingWaits();
    if (threadId && turnId) {
      void dependencies
        .write(
          generation,
          buildCodexTurnInterruptRequest({
            requestId: requestId(request.requestId, 'interrupt'),
            threadId,
            turnId,
          }),
        )
        .catch(() => undefined);
    }
    void dependencies.stop(generation).catch(() => false);
  };
  request.signal?.addEventListener('abort', abort, { once: true });
  try {
    const subscription = dependencies.frames(generation, request.signal);
    const activeIterator = subscription.stream[Symbol.asyncIterator]();
    iterator = activeIterator;
    const firstFrame = activeIterator.next();
    let prefetched: Promise<IteratorResult<NativeFrame>> | undefined = firstFrame;
    const reader: AsyncIterator<NativeFrame> = {
      next: () => {
        if (prefetched) {
          const next = prefetched;
          prefetched = undefined;
          return next;
        }
        return activeIterator.next();
      },
      return: (value) => activeIterator.return?.(value) ?? Promise.resolve({ done: true, value }),
    };
    // Opening the bridge can fail before nativeCodexFrames acknowledges subscription.
    // Observe that failure immediately instead of leaving readiness pending forever.
    await prepare(request, 'subscription', () => Promise.race([
      subscription.ready,
      firstFrame.then((first) => {
        if (first.done) throw new Error('Codex app-server ended before subscription.');
        return new Promise<never>(() => {});
      }),
    ]));
    if (request.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
    const exactIdentity = identity(request);
    await prepare(request, 'catalog', () => validateModelCapability(
      generation,
      reader,
      exactIdentity,
      dependencies.write,
      request.requestId,
    ));
    let threadRequestId = requestId(request.requestId, request.sessionId ? 'resume' : 'thread');
    const threadRequest = request.sessionId
      ? buildCodexThreadResumeRequest({
          requestId: threadRequestId,
          threadId: request.sessionId,
          identity: exactIdentity,
          mode,
          developerInstructions: developerInstructions(request),
        })
      : buildCodexThreadStartRequest({
          requestId: threadRequestId,
          identity: exactIdentity,
          mode,
          developerInstructions: developerInstructions(request),
          ...(contextTool ? { dynamicTools: [CODEX_CONTEXT_TOOL] } : {}),
        });
    await dependencies.write(generation, threadRequest);
    let threadResponse = await prepare(request, request.sessionId ? 'resume' : 'thread',
      () => responseFrame(reader, threadRequestId));
    let resumed = Boolean(request.sessionId);
    const resumeError = recordOf(threadResponse.error);
    if (resumed && recoverImplicitThread && !request.expectedSessionId &&
      resumeError?.code === -32600 && typeof resumeError.message === 'string' &&
      /^no rollout found for thread id\b/i.test(resumeError.message)) {
      if (request.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
      // Isolated provider profiles may not contain an implicitly cached thread.
      // No turn was sent: start once and restore the supplied chat context.
      threadRequestId = requestId(request.requestId, 'thread');
      await dependencies.write(generation, buildCodexThreadStartRequest({
        requestId: threadRequestId, identity: exactIdentity, mode,
        developerInstructions: developerInstructions(request),
        ...(contextTool ? { dynamicTools: [CODEX_CONTEXT_TOOL] } : {}),
      }));
      threadResponse = await responseFrame(reader, threadRequestId);
      resumed = false;
    }
    if (resumed) {
      const projection = normalizeCodexThreadBindingResponse(threadResponse, threadRequestId);
      const session = projection.events.find(
        (event): event is Extract<ProviderEvent, { type: 'session' }> => event.type === 'session',
      );
      threadId = session?.sessionId;
    } else {
      const validation = validateCodexThreadStartResponse(
        threadResponse,
        threadRequestId,
        exactIdentity,
        mode,
      );
      if (!validation.ok) {
        throw new Error('Codex thread identity mismatch: ' + validation.field + '.');
      }
      threadId = validation.threadId;
    }
    if (!threadId) throw new Error('Codex thread binding is unavailable.');
    if (contextTool) {
      const validated = validateCodexThreadStartResponse(threadResponse, threadRequestId, exactIdentity, mode);
      if (!validated.ok) throw new Error('Codex Context thread identity mismatch: ' + validated.field + '.');
      contextTool.bind(threadId, exactIdentity, generation);
    }
    if (resumed && request.systemPrompt?.trim()) {
      // Resume restores the old developer message. Publish this turn's compiled
      // policy explicitly while retaining Codex's built-in Ask/Plan instructions.
      const policyRequestId = requestId(request.requestId, 'policy');
      await dependencies.write(generation, buildCodexThreadPolicyUpdateRequest({
        requestId: policyRequestId, threadId, developerInstructions: developerInstructions(request),
      }));
      const policyResponse = await prepare(request, 'policy', () => responseFrame(reader, policyRequestId));
      if (recordOf(policyResponse.error) || !recordOf(policyResponse.result)) {
        throw new Error('Codex current-turn policy update failed.');
      }
    }
    yield { type: 'session', sessionId: threadId };
    if (request.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
    await Promise.race([request.onSessionBound?.({ sessionId: threadId }), cancelled]);
    if (request.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');

    await dependencies.write(
      generation,
      buildCodexTurnStartRequest({
        requestId: requestId(request.requestId, 'turn'),
        threadId,
        clientUserMessageId: requestId(request.requestId, 'message'),
        text: promptText(request, !resumed),
        identity: exactIdentity,
        mode,
      }),
    );

    const turnUsage = createTurnUsageAccumulator();
    for (let count = 0; count < 65_536; count += 1) {
      if (request.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
      const frame = await nextFrame(reader, 'Codex app-server ended before terminal state.');
      if (request.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
      if (frame.id === requestId(request.requestId, 'turn') && recordOf(frame.error)) {
        const code = recordOf(frame.error)?.code;
        throw new Error(`Codex rejected turn/start (${Number.isInteger(code) ? code : 'unknown'}).`);
      }
      if (frame.method === 'item/tool/call') {
        const params = recordOf(frame.params);
        if (!contextTool || !turnId || params?.threadId !== threadId || params.turnId !== turnId ||
            params.tool !== CODEX_CONTEXT_TOOL.name || params.namespace != null ||
            typeof params.callId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/.test(params.callId) ||
            (typeof frame.id !== 'string' && typeof frame.id !== 'number')) {
          throw new Error('Codex Context tool call has an invalid turn or tool binding.');
        }
        yield { type: 'tool', name: CODEX_CONTEXT_TOOL.name, status: 'started', callId: params.callId };
        let result;
        try { result = await contextTool.execute(params.arguments, params.callId); }
        catch {
          result = { success: false, contentItems: [{ type: 'inputText' as const, text: 'The scoped VibeSpace Context request could not be completed.' }] };
        }
        if (request.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
        await dependencies.write(generation, { id: frame.id, result });
        yield { type: 'tool', name: CODEX_CONTEXT_TOOL.name, status: result.success ? 'completed' : 'failed', callId: params.callId };
        continue;
      }
      const projection = normalizeCodexAppServerMessage(frame, {
        scope: {
          activeGeneration: 1,
          messageGeneration: 1,
          threadId,
          ...(turnId ? { turnId } : {}),
        },
      });
      for (const control of projection.controls) {
        if (control.type === 'approval') {
          const approval = controls.approval(control, frame.id as string | number,
            recordOf(recordOf(frame.params)?.permissions ?? recordOf(frame.params)?.additionalPermissions));
          if (!request.onApprovalRequested) throw new Error('Codex approval handler is unavailable.');
          await Promise.race([request.onApprovalRequested(approval), cancelled]);
          if (request.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
        } else if (control.type === 'question') {
          const id = controls.question(control, frame.id as string | number);
          for (const event of projection.events) if (event.type === 'question') event.request = { ...event.request, id };
        } else if (control.type === 'secure_question') {
          throw new Error('Codex requested secure input. Complete it in the Codex CLI.');
        }
        if (control.type === 'turn_binding') {
          if (control.threadId !== threadId || (turnId && turnId !== control.turnId)) {
            throw new Error('Codex turn binding changed unexpectedly.');
          }
          turnId = control.turnId;
        }
      }
      for (const event of projection.events) {
        if (event.type === 'done' || event.type === 'error') terminal = true;
        yield event.type === 'usage' ? { ...event, usage: turnUsage(event.usage, frame) } : event;
      }
      if (terminal) return;
    }
    throw new Error('Codex turn exceeded its safe event bound.');
  } catch (error) {
    if (request.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
    throw error;
  } finally {
    controls.dispose();
    request.signal?.removeEventListener('abort', abort);
    await dependencies.stop(generation).catch(() => false);
    await iterator?.return?.();
  }
}

export function createCodexPersistentAdapter(
  dependencies: CodexPersistentDependencies = defaultDependencies,
): ProviderAdapter {
  return Object.freeze({
    id: 'codex-app-server',
    send: async function* (request: ProviderRequest) {
      const release = await prepare(request, 'lease', () => codexTurnLease.acquire(request.signal));
      let contextTool: CodexContextToolBridge | null = null;
      try {
      await prepare(request, 'recover', () => codexTurnLease.recover(dependencies.stop));
      contextTool = await prepare(request, 'context', async () => await dependencies.contextTool?.(request) ?? null);
      const ownedDependencies = {
        ...dependencies,
        async start(...args: Parameters<CodexPersistentDependencies['start']>) {
          const result = await dependencies.start(...args);
          try { codexTurnLease.remember(result.generation); }
          catch (error) { await dependencies.stop(result.generation); throw error; }
          return result;
        },
        async stop(generation: string) {
          const stopped = await dependencies.stop(generation);
          codexTurnLease.forget(generation);
          return stopped;
        },
      };
      const key = request.accountId && request.chatId && request.workingDirectory
        ? (contextTool ? 'vibespace.codex-context-thread.v1:' : 'vibespace.codex-thread.v1:') + JSON.stringify([request.accountId, request.workspaceId,
            request.projectId, request.chatId, request.workingDirectory]) : undefined;
      let sessionId = request.sessionId;
      if (!sessionId && key) {
        try {
          const stored = localStorage.getItem(key);
          if (stored && /^[A-Za-z0-9._:-]{1,256}$/u.test(stored)) sessionId = stored;
        } catch { /* Native startup still works when local persistence is unavailable. */ }
      }
      for await (const event of sendCodexRequest(
        { ...request, sessionId }, ownedDependencies, !request.sessionId && !request.expectedSessionId, contextTool,
      )) {
        if (key && event.type === 'session') {
          try { localStorage.setItem(key, event.sessionId); } catch { /* Current turn remains usable. */ }
        }
        yield event;
      }
      } finally { contextTool?.dispose(); release(); }
    },
    cancel: async () => undefined,
  });
}

export const codexPersistentAdapter = createCodexPersistentAdapter();
