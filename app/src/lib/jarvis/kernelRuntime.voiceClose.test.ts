import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJarvisDb, type JarvisDexie } from '@/lib/db';
import { fromJarvisRunRow, toJarvisRunRow } from '@/lib/db/jarvisMappers';
import { createJarvisRepositories } from '@/lib/db/jarvisRepositories';
import { TEST_INDEXED_DB, uniqueTestDbName } from '@/test/indexedDb';
import { useAuthStore } from '@/stores/auth';
import type { Agent, ChatId, WorkspaceId } from '@/types';
import type { JarvisResponseEnvelope, JarvisRun } from './contracts';
import type { JarvisKernelTurnInput } from './kernel';
import { createJarvisKernelRuntime } from './kernelRuntime';
const NOW = 1_786_300_100_000;

function artifactAuthorities() {
  const ready = (producerId: string) =>
    Object.freeze({
      state: 'ready' as const,
      producerId,
      authority: Object.freeze({ verify: vi.fn(async (value: unknown) => value) }),
    });
  return Object.freeze({
    provider: ready('provider_response'),
    fileAction: ready('file_action_result'),
    terminal: ready('terminal_exit'),
    plugin: ready('plugin_result'),
    mcp: ready('mcp_result'),
    schedule: Object.freeze({
      state: 'unavailable' as const,
      producerId: 'schedule_result',
      reason: 'producer_task_not_landed' as const,
    }),
  });
}

function unavailableVerifiers() {
  const unavailable = <K extends string>(producerKind: K) =>
    Object.freeze({
      state: 'unavailable' as const,
      producerKind,
      reason: 'producer_task_not_landed' as const,
    });
  return Object.freeze({
    provider: unavailable('provider'),
    action: unavailable('action'),
    fileAction: unavailable('file_action'),
    terminal: unavailable('terminal'),
    plugin: unavailable('plugin'),
    mcp: unavailable('mcp'),
    voice: unavailable('voice'),
    schedule: unavailable('schedule'),
    hive: unavailable('hive'),
  });
}

function kernelRun(): JarvisRun {
  return {
    id: 'run-runtime-kernel',
    accountId: 'account-kernel',
    workspaceId: 'workspace-kernel',
    chatId: 'chat-runtime-kernel',
    source: 'typed_chat',
    status: 'queued',
    agentId: 'agent-runtime-jarvis',
    identityVersion: 1,
    profileRevisionId: 'profile-runtime-kernel',
    model: {
      connectionId: 'connection-runtime-kernel',
      providerId: 'provider-kernel',
      modelId: 'model-kernel',
      connectionMode: 'native-api',
      capabilities: { tools: true, vision: false },
      capturedAt: NOW - 10,
    },
    createdAt: NOW - 20,
    updatedAt: NOW - 20,
  };
}

function kernelTurn(): JarvisKernelTurnInput {
  const current = kernelRun();
  const protectedJarvis: Agent = {
    id: 'agent-runtime-jarvis' as Agent['id'],
    slug: 'jarvis',
    name: 'Jarvis',
    description: 'Protected Jarvis',
    system_prompt: 'Legacy prompt.',
    model: { provider: 'mock', model: 'mock-default' },
    tools_allowed: [],
    memory_scope: 'workspace',
    capabilities: [],
    builtin: true,
    created_at: NOW - 20,
    updated_at: NOW - 20,
  };
  return {
    run: current,
    attempt: {
      kind: 'initial',
      requestId: 'request-runtime-kernel',
      runId: current.id,
      attemptNumber: 1,
    },
    accountId: current.accountId,
    workspaceId: current.workspaceId,
    chatId: current.chatId!,
    userMessageId: 'message-runtime-user',
    agent: protectedJarvis,
    surface: 'typed_chat',
    interactionMode: 'ask',
    userText: 'Give me the runtime answer.',
    messageHistory: [{ role: 'user', content: 'Give me the runtime answer.' }],
    model: current.model,
    identity: {
      identityVersion: 1,
      coreHash: 'core-runtime-kernel',
      responseContractHash: 'response-runtime-kernel',
    },
    profile: {
      profileId: 'profile-runtime-kernel',
      revisionId: 'profile-runtime-kernel',
      customInstructions: '',
      memoryScope: 'profile',
    },
    capabilities: {
      capturedAt: NOW - 10,
      tools: [],
      plugins: [],
      mcps: [],
      terminals: [],
      agents: [],
      entitlements: { source: 'local_development', capabilities: [] },
    },
    context: { items: [], budget: { maxChars: 4_000, usedChars: 0 }, exclusions: [] },
    outputContract: {
      preserveStructuredBlocks: true,
      allowActionBlocks: true,
      allowPlanBlocks: true,
      allowQuestionBlocks: true,
      allowPermissionBlocks: true,
      voiceDelivery: 'validated_stream',
    },
  };
}

const fixture = vi.hoisted(() => ({
  speakReplies: true,
  synthesisFails: false,
  invocationCount: 0,
  forbiddenCalls: [] as string[],
}));
const forbidden = (name: string) => {
  fixture.forbiddenCalls.push(name);
  throw new Error(`forbidden_fixture_port:${name}`);
};
vi.mock('@/stores/ui', () => ({
  useUIStore: {
    getState: () => ({ voiceModalOpen: fixture.speakReplies, setVoiceListening: vi.fn() }),
  },
}));
vi.mock('@/components/ui/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('@/lib/utils', () => ({ isTauri: true }));
vi.mock('@/features/voice/providers/jarvisHighLocal', () => ({
  jarvisHighLocalProvider: {
    isAvailable: vi.fn(async () => true),
    stop: vi.fn(),
    warmup: vi.fn(async () => undefined),
  },
}));
vi.mock('@/features/voice/providers/deepgramTts', () => ({
  deepgramTtsProvider: { isAvailable: vi.fn(async () => false) },
}));
vi.mock('@/features/voice/modelManager', () => ({
  ModelManager: { ensureJarvisReady: () => forbidden('model_setup') },
}));
vi.mock('@/features/voice/TtsService', () => ({
  TtsService: {
    stop: vi.fn(),
    setProvider: vi.fn(),
    setVoicePreset: vi.fn(),
    speak: () => forbidden('cloud_tts'),
    warmup: () => forbidden('tts_warmup'),
    testVoice: () => forbidden('tts_preview'),
  },
}));
vi.mock('@/features/voice/VoiceService', () => ({
  VoiceService: { stopListening: vi.fn(), startListening: () => forbidden('microphone') },
}));
vi.mock('@/features/voice/store', () => ({
  useVoiceStore: {
    getState: () => ({
      session: null,
      setState: vi.fn(),
      setPartialTranscript: vi.fn(),
      endSession: vi.fn(),
    }),
  },
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string) => {
    if (command !== 'jarvis_voice_speak') return forbidden(`native:${command}`);
    fixture.invocationCount += 1;
    if (fixture.synthesisFails) throw new Error('synthetic_synthesis_failure');
    return { audio: 'AA==', mime: 'audio/wav' };
  },
}));

import { createJarvisAbortRegistry } from '@/lib/jarvis/executionJournal/abortRegistry';
import { createCanonicalVoicePlaybackAdapter } from '@/features/voice/streamingVoice';
import {
  registerActiveVoiceTurnCancellation,
  handleVoiceModuleClosed,
  syncVoiceModuleOpenState,
  stopCurrentVoiceResponse,
  stopAllVoiceOutput,
} from '@/features/voice/voiceRouter';
let db: JarvisDexie;
let audio: SyntheticAudio[];
let endAutomatically: boolean;
class SyntheticAudio extends EventTarget {
  src: string;
  paused = false;
  ended = false;
  volume = 1;
  constructor(src: string) {
    super();
    this.src = src;
    audio.push(this);
  }
  pause() {
    this.paused = true;
  }
  play() {
    if (endAutomatically)
      queueMicrotask(() => {
        this.ended = true;
        this.dispatchEvent(new Event('ended'));
      });
    return Promise.resolve();
  }
}
beforeEach(async () => {
  db = createJarvisDb(uniqueTestDbName('voice-close-actual'), TEST_INDEXED_DB);
  await db.open();
  useAuthStore.setState({
    cloudSession: null,
    localUserId: 'account-kernel',
    voiceEngine: 'jarvis',
    voicePreset: 'jarvis-prime',
    speakReplies: false,
  });
  fixture.speakReplies = true;
  fixture.synthesisFails = false;
  fixture.forbiddenCalls = [];
  audio = [];
  endAutomatically = false;
  vi.spyOn(Date, 'now').mockReturnValue(NOW + 100);
  vi.stubGlobal('Audio', SyntheticAudio);
  vi.stubGlobal('AudioContext', undefined);
  vi.stubGlobal('SpeechSynthesisUtterance', undefined);
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: undefined });
  vi.stubGlobal('fetch', () => forbidden('fetch'));
  vi.stubGlobal(
    'WebSocket',
    class {
      constructor() {
        forbidden('websocket');
      }
    },
  );
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: () => forbidden('microphone') },
  });
  URL.createObjectURL = vi.fn(() => 'blob:synthetic-voice-close');
  URL.revokeObjectURL = vi.fn();
  syncVoiceModuleOpenState(true);
});
afterEach(async () => {
  registerActiveVoiceTurnCancellation(null);
  fixture.speakReplies = false;
  handleVoiceModuleClosed();
  await db.delete();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  expect(fixture.forbiddenCalls).toEqual([]);
});
async function setup(options: { prepareGate?: Promise<void> } = {}) {
  const base = kernelTurn();
  const turn: JarvisKernelTurnInput & { surface: 'voice' } = {
    ...base,
    run: { ...base.run, source: 'voice' },
    surface: 'voice',
  };
  await db.jarvis_runs.add(toJarvisRunRow(turn.run));
  await db.chats.add({
    id: turn.chatId as ChatId,
    workspace_id: turn.workspaceId as WorkspaceId,
    title: 'synthetic close',
    mode: 'chat',
    active_agent_ids: [turn.agent.id],
    created_at: NOW - 20,
    updated_at: NOW - 20,
  });
  const repos = createJarvisRepositories(db);
  const registry = createJarvisAbortRegistry({
    getRun: repos.run.getById,
    newCancellationRequestId: () => 'synthetic-close-cancel',
  });
  const playbackAdapter = createCanonicalVoicePlaybackAdapter();
  const processed: JarvisResponseEnvelope = {
    schemaVersion: 1,
    requestId: turn.attempt.requestId,
    runId: turn.run.id,
    mode: 'direct_answer',
    displayText: 'Runtime voice answer.',
    spokenText: 'Runtime voice answer.',
    parts: [{ kind: 'text', text: 'Runtime voice answer.' }],
    artifactIds: [],
    sourceRefs: [],
    executionState: { status: 'completed', verifiedBy: 'journal', lastEventSeq: 4 },
    provider: turn.model,
    enforcement: {
      linted: true,
      violations: [],
      repairAttempted: false,
      repairSucceeded: false,
      fallbackUsed: false,
    },
    completedAt: NOW + 10,
  };
  const runtime = createJarvisKernelRuntime({
    db,
    artifactEvidenceAuthorities: artifactAuthorities() as never,
    journal: { allocateRun: vi.fn(), getRun: vi.fn(async () => turn.run) },
    cancellationDeliveryAuthority: {
      ...registry.cancellationDeliveryAuthority,
      prepare: async (accountId, runId) => {
        await options.prepareGate;
        return registry.cancellationDeliveryAuthority.prepare(accountId, runId);
      },
    },
    abortRegistrationAuthority: registry.registrationAuthority,
    bindKernelActions: vi.fn() as never,
    liveEvidenceVerifiers: {
      ...unavailableVerifiers(),
      provider: {
        state: 'ready',
        producerKind: 'provider',
        verifier: { verify: async (v: unknown) => v },
      },
      voice: {
        state: 'ready',
        producerKind: 'voice',
        verifier: { verify: async (v: unknown) => v, authorizeStart: () => () => {} },
      },
    } as never,
    voiceLiveEvidenceStartAuthority: { authorizeStart: () => () => {} },
    voicePlaybackAdapter: playbackAdapter,
    onVoiceTurnHandleIssued: ({ handle }) =>
      registerActiveVoiceTurnCancellation({
        requestCancellation: () => handle.requestCancellation(),
      }),
    prepareProvider: vi.fn(async () => ({
      resolveConfiguration: vi.fn(async () => ({
        start: vi.fn(() => ({
          receipt: {
            providerId: 'provider-kernel',
            modelId: 'model-kernel',
            modelSnapshotRef: 'provider-kernel:model-kernel',
            operations: ['generate'] as const,
            startedAt: NOW + 5,
          },
          response: Promise.resolve({
            text: 'Runtime voice answer.',
            provider: turn.model,
            verifiedFacts: {
              executionState: {
                status: 'completed' as const,
                verifiedBy: 'journal' as const,
                lastEventSeq: 4,
              },
              modelState: 'authenticated' as const,
              plugins: [],
              mcps: [],
            },
            completedAt: NOW + 10,
          }),
          abortAfterStart: vi.fn(),
        })),
        dispose: vi.fn(),
      })),
      dispose: vi.fn(),
    })),
    processResponse: vi.fn(async () => processed),
    takeProviderArtifactDrafts: vi.fn(() => []),
    randomUUID: () => 'voice-close-uuid',
    now: () => NOW + 100,
  });
  const started = await runtime.kernel.startVoiceTurn(turn);
  if (started.kind !== 'committed') throw new Error('voice turn not admitted');
  const commit = await started.value.handle.commitResponseReady();
  expect(commit).toMatchObject({
    kind: 'committed',
    value: { committed: true, run: { status: 'running' } },
  });
  const completion = started.value.handle.runValidatedPlayback().then(
    (value) => ({ value, error: null }),
    (error) => ({ value: null, error: String(error) }),
  );
  return { turn, registry, runtime, handle: started.value.handle, completion };
}
describe('real kernel + abort registry + streaming adapter + router Close with synthetic media', () => {
  it('natural media end commits completed', async () => {
    endAutomatically = true;
    const h = await setup();
    const outcome = await h.completion;
    expect(outcome.error).toBeNull();
    expect(outcome.value).toMatchObject({
      kind: 'committed',
      value: { committed: true, run: { status: 'completed' } },
    });
    expect(audio[0].ended).toBe(true);
    h.runtime.liveEvidenceHost.dispose();
  });
  it('owner-directed cancellation after model completion commits cancelled', async () => {
    const h = await setup();
    await vi.waitFor(() => expect(audio.length).toBeGreaterThan(0));
    expect(
      h.registry.readRunDiagnostic(h.turn.accountId, h.turn.run.id).owners.map((x) => x.kind),
    ).toEqual(['tts_generation', 'audio_playback']);
    const cancellation = await h.handle.requestCancellation();
    const outcome = await h.completion;
    expect(cancellation).toMatchObject({
      kind: 'intent_committed',
      aggregate: { kind: 'signal_delivered' },
    });
    expect(outcome.error).toBeNull();
    expect(outcome.value).toMatchObject({
      kind: 'committed',
      value: { committed: true, run: { status: 'cancelled' } },
    });
    expect(audio[0].paused).toBe(true);
    expect(audio[0].ended).toBe(false);
    h.runtime.liveEvidenceHost.dispose();
  });
  it('Close keeps immediate audio stop joined to owned cancellation after model completion', async () => {
    const h = await setup();
    await vi.waitFor(() => expect(audio.length).toBeGreaterThan(0));
    fixture.speakReplies = false;
    handleVoiceModuleClosed();
    const outcome = await h.completion;
    const run = fromJarvisRunRow((await db.jarvis_runs.get(h.turn.run.id))!);
    const events = (await db.jarvis_events.toArray()).map((x) => ({
      seq: x.seq,
      type: x.type,
      status: x.status,
    }));
    expect(audio[0].paused).toBe(true);
    expect(audio[0].ended).toBe(false);
    expect(outcome.error).toBeNull();
    expect(run.status).toBe('cancelled');
    h.runtime.liveEvidenceHost.dispose();
  });
});

function deferredGate() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
describe('held intent and unresolved owner controls', () => {
  it('repeated Close shares one intent and preserves immediate cutoff', async () => {
    const gate = deferredGate();
    const h = await setup({ prepareGate: gate.promise });
    await vi.waitFor(() => expect(audio.length).toBeGreaterThan(0));
    fixture.speakReplies = false;
    handleVoiceModuleClosed();
    handleVoiceModuleClosed();
    expect(audio[0].paused).toBe(true);
    gate.resolve();
    const outcome = await h.completion;
    expect(outcome.value).toMatchObject({ value: { run: { status: 'cancelled' } } });
    expect(
      (await db.jarvis_events.toArray()).filter((x) => x.status === 'cancellation_requested'),
    ).toHaveLength(1);
    expect(h.registry.readRunDiagnostic(h.turn.accountId, h.turn.run.id).owners).toEqual([]);
    h.runtime.liveEvidenceHost.dispose();
  });
  it('account revocation while intent is held cannot create cancellation ACK', async () => {
    const gate = deferredGate();
    const h = await setup({ prepareGate: gate.promise });
    await vi.waitFor(() => expect(audio.length).toBeGreaterThan(0));
    fixture.speakReplies = false;
    handleVoiceModuleClosed();
    expect(audio[0].paused).toBe(true);
    useAuthStore.setState({ localUserId: 'different-synthetic-account' });
    gate.resolve();
    const outcome = await h.completion;
    expect(outcome.value).toMatchObject({ kind: 'account_authority_revoked' });
    expect(fromJarvisRunRow((await db.jarvis_runs.get(h.turn.run.id))!).status).toBe('running');
    expect((await db.jarvis_events.toArray()).some((x) => x.status === 'cancelled')).toBe(false);
    expect(h.registry.readRunDiagnostic(h.turn.accountId, h.turn.run.id).owners).toEqual([]);
    h.runtime.liveEvidenceHost.dispose();
  });
  it('held intent preserves immediate physical cutoff and retains the owned controller until late delivery', async () => {
    const gate = deferredGate();
    const h = await setup({ prepareGate: gate.promise });
    await vi.waitFor(() => expect(audio.length).toBeGreaterThan(0));
    fixture.speakReplies = false;
    handleVoiceModuleClosed();
    try {
      expect(audio[0].paused).toBe(true);
      expect(audio[0].ended).toBe(false);
      await vi.waitFor(async () =>
        expect(
          (await db.jarvis_events.toArray()).filter(
            (x) =>
              x.producer_source_evidence?.producerKind === 'voice' &&
              x.producer_source_evidence.phase === 'result',
          ),
        ).toHaveLength(2),
      );
      const diagnostic = h.registry.readRunDiagnostic(h.turn.accountId, h.turn.run.id);
      expect(fromJarvisRunRow((await db.jarvis_runs.get(h.turn.run.id))!).status).toBe('running');
      expect(diagnostic.owners.map((x) => x.kind)).toEqual(['tts_generation', 'audio_playback']);
    } finally {
      gate.resolve();
      await h.completion;
      h.runtime.liveEvidenceHost.dispose();
    }
  });
  it('rejected intent still cuts audio and never invents cancellation ACK', async () => {
    const gate = deferredGate();
    const h = await setup({ prepareGate: gate.promise });
    await vi.waitFor(() => expect(audio.length).toBeGreaterThan(0));
    fixture.speakReplies = false;
    const cancellation = stopCurrentVoiceResponse().then(
      () => null,
      (error) => String(error),
    );
    expect(audio[0].paused).toBe(true);
    gate.reject(new Error('synthetic_intent_rejected'));
    expect(await cancellation).toContain('synthetic_intent_rejected');
    const outcome = await h.completion;
    expect(outcome.error).not.toBeNull();
    const row = fromJarvisRunRow((await db.jarvis_runs.get(h.turn.run.id))!);
    expect(row.status).toBe('running');
    expect((await db.jarvis_events.toArray()).some((x) => x.status === 'cancelled')).toBe(false);
    h.runtime.liveEvidenceHost.dispose();
  });
  it('an additional genuinely unverified tool owner prevents terminal cancellation despite stopped audio', async () => {
    const h = await setup();
    await vi.waitFor(() => expect(audio.length).toBeGreaterThan(0));
    const release = h.registry.registrationAuthority.registerIssuedOwner({
      accountId: h.turn.accountId,
      runId: h.turn.run.id,
      registrationId: 'synthetic-unverified-tool',
      kind: 'terminal',
      abort: () => ({ kind: 'unsupported', ownerId: 'synthetic-unverified-tool' }),
    });
    await h.handle.requestCancellation();
    const outcome = await h.completion;
    expect(audio[0].paused).toBe(true);
    expect(outcome.error).toContain('voice_cancellation_unverified');
    expect(fromJarvisRunRow((await db.jarvis_runs.get(h.turn.run.id))!).status).toBe('running');
    release();
    h.runtime.liveEvidenceHost.dispose();
  });
});

describe('local-stop receipt and replacement ownership', () => {
  it('does not acknowledge cancellation for failed media', async () => {
    vi.stubGlobal(
      'Audio',
      class extends SyntheticAudio {
        play() {
          queueMicrotask(() => this.dispatchEvent(new Event('error')));
          return Promise.resolve();
        }
      },
    );
    const controller = createCanonicalVoicePlaybackAdapter().prepare({
      accountId: 'synthetic',
      runId: 'failed-media',
      requestId: 'failed-media-request',
      attemptNumber: 1,
      spokenText: 'Synthetic failed media.',
    })!;
    const result = await controller.start();
    expect(result.playback).toMatchObject({ state: 'degraded', reason: 'failed' });
    expect(controller.abort()).toBe('already_exited');
    controller.dispose();
  });
  it.each(['natural-end', 'unavailable'] as const)(
    'does not acknowledge cancellation after %s',
    async (outcome) => {
      endAutomatically = true;
      if (outcome === 'unavailable') fixture.speakReplies = false;
      const controller = createCanonicalVoicePlaybackAdapter().prepare({
        accountId: 'synthetic',
        runId: 'non-stopped',
        requestId: 'non-stopped-request',
        attemptNumber: 1,
        spokenText: 'Synthetic completion boundary.',
      })!;
      const result = await controller.start();
      expect(result.playback).toMatchObject(
        outcome === 'natural-end'
          ? { state: 'completed' }
          : { state: 'degraded', reason: 'unavailable' },
      );
      expect(controller.abort()).toBe('already_exited');
      controller.dispose();
    },
  );
  it('acknowledges a later signal only for its own locally stopped undisposed session', async () => {
    const controller = createCanonicalVoicePlaybackAdapter().prepare({
      accountId: 'synthetic',
      runId: 'local-receipt',
      requestId: 'local-request',
      attemptNumber: 1,
      spokenText: 'Synthetic local stop.',
    })!;
    const pending = controller.start();
    await vi.waitFor(() => expect(audio.length).toBeGreaterThan(0));
    stopAllVoiceOutput();
    const result = await pending;
    try {
      expect(result.playback).toMatchObject({ state: 'degraded', reason: 'stopped' });
      expect(controller.abort()).toBe('signal_delivered');
      expect(controller.abort()).toBe('already_exited');
      expect(controller.verify(result)).toBe(true);
    } finally {
      controller.dispose();
    }
    expect(controller.abort()).toBe('already_exited');
  });
  it('late old cancellation and disposal preserve replacement audio and its stop ownership', async () => {
    const gate = deferredGate();
    const h = await setup({ prepareGate: gate.promise });
    await vi.waitFor(() => expect(audio.length).toBe(1));
    fixture.speakReplies = false;
    handleVoiceModuleClosed();
    await vi.waitFor(async () =>
      expect(
        (await db.jarvis_events.toArray()).filter(
          (x) =>
            x.producer_source_evidence?.producerKind === 'voice' &&
            x.producer_source_evidence.phase === 'result',
        ),
      ).toHaveLength(2),
    );
    fixture.speakReplies = true;
    syncVoiceModuleOpenState(true);
    const successor = createCanonicalVoicePlaybackAdapter().prepare({
      accountId: 'synthetic',
      runId: 'successor',
      requestId: 'successor-request',
      attemptNumber: 1,
      spokenText: 'Synthetic replacement output.',
    })!;
    const next = successor.start();
    await vi.waitFor(() => expect(audio.length).toBe(2));
    try {
      gate.resolve();
      await h.completion;
      expect(audio[1].paused).toBe(false);
      expect(audio[1].ended).toBe(false);
      stopAllVoiceOutput();
      const result = await next;
      expect(audio[1].paused).toBe(true);
      expect(result.playback).toMatchObject({ state: 'degraded', reason: 'stopped' });
    } finally {
      gate.resolve();
      await h.completion;
      successor.dispose();
      h.runtime.liveEvidenceHost.dispose();
    }
  });
});
