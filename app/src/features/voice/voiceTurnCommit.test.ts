import { describe, expect, it, vi } from 'vitest';
import type { JarvisEventRepository, JarvisRunRepository } from '@/lib/db/jarvisRepositories';
import type {
  JarvisCanonicalLiveProducerEvidence,
  JarvisEvent,
  JarvisRun,
} from '@/lib/jarvis/contracts/execution';
import {
  VOICE_COMMIT_PHRASE_DEFAULT,
  clampVoiceCommitPhrase,
  createJarvisVoiceLiveEvidenceVerifier,
  detectCancelPhrase,
  detectCommitPhrase,
  normalizeVoicePhrase,
  processVoiceFinalEvent,
  shouldAutoSendOnSilence,
  stripCommitPhrase,
} from './voiceTurnCommit';

describe('voiceTurnCommit', () => {
  it('normalizes phrases for case-insensitive matching', () => {
    expect(normalizeVoicePhrase('Send  IT!!!')).toBe('send it');
  });

  it('detects commit phrase at end of transcript', () => {
    const result = detectCommitPhrase('Help me plan a landing page send it', 'send it');
    expect(result.committed).toBe(true);
    expect(result.messageText).toBe('help me plan a landing page');
  });

  it('detects commit phrase when transcript is only the phrase', () => {
    const result = detectCommitPhrase('send it', 'send it');
    expect(result.committed).toBe(true);
    expect(result.messageText).toBe('');
  });

  it('does not commit without the phrase', () => {
    const result = detectCommitPhrase('So the idea is', 'send it');
    expect(result.committed).toBe(false);
  });

  it('strips commit phrase case-insensitively', () => {
    expect(stripCommitPhrase('Make it shorter SEND IT', 'send it')).toBe('make it shorter');
  });

  it('detects cancel phrase', () => {
    expect(detectCancelPhrase('never mind cancel', 'cancel')).toBe(true);
    expect(detectCancelPhrase('keep going', 'cancel')).toBe(false);
  });

  it('clamps commit phrase length', () => {
    expect(clampVoiceCommitPhrase('a')).toBe(VOICE_COMMIT_PHRASE_DEFAULT);
    expect(clampVoiceCommitPhrase('  go ahead  ')).toBe('go ahead');
  });

  it('uses silence auto-send only for click-to-talk or hands-free silence mode', () => {
    expect(shouldAutoSendOnSilence(false, 'phrase')).toBe(true);
    expect(shouldAutoSendOnSilence(true, 'phrase')).toBe(false);
    expect(shouldAutoSendOnSilence(true, 'silence')).toBe(true);
  });

  it('ignores finals while Jarvis is busy', () => {
    expect(
      processVoiceFinalEvent({
        finalText: 'more talking',
        currentDraft: 'hello',
        turnBusy: true,
        handsFree: true,
        endTrigger: 'phrase',
        commitPhrase: 'send it',
        cancelPhrase: 'cancel',
      }),
    ).toEqual({ type: 'ignore' });
  });

  it('accumulates without commit phrase in hands-free phrase mode', () => {
    expect(
      processVoiceFinalEvent({
        finalText: 'another thought',
        currentDraft: 'so the idea is',
        turnBusy: false,
        handsFree: true,
        endTrigger: 'phrase',
        commitPhrase: 'send it',
        cancelPhrase: 'cancel',
      }),
    ).toEqual({ type: 'accumulate', draft: 'so the idea is another thought' });
  });

  it('commits when phrase is spoken', () => {
    expect(
      processVoiceFinalEvent({
        finalText: 'send it',
        currentDraft: 'help me plan',
        turnBusy: false,
        handsFree: true,
        endTrigger: 'phrase',
        commitPhrase: 'send it',
        cancelPhrase: 'cancel',
      }),
    ).toEqual({ type: 'commit', draft: '', messageText: 'help me plan' });
  });

  it('cancels draft on cancel phrase', () => {
    expect(
      processVoiceFinalEvent({
        finalText: 'cancel',
        currentDraft: 'actually never mind',
        turnBusy: false,
        handsFree: true,
        endTrigger: 'phrase',
        commitPhrase: 'send it',
        cancelPhrase: 'cancel',
      }),
    ).toEqual({ type: 'cancel', draft: '' });
  });

  it('schedules silence flush for click-to-talk', () => {
    expect(
      processVoiceFinalEvent({
        finalText: 'hello there',
        currentDraft: '',
        turnBusy: false,
        handsFree: false,
        endTrigger: 'phrase',
        commitPhrase: 'send it',
        cancelPhrase: 'cancel',
      }),
    ).toEqual({ type: 'schedule_flush', draft: 'hello there' });
  });
});

describe('createJarvisVoiceLiveEvidenceVerifier', () => {
  const run: JarvisRun = {
    id: 'run-voice-evidence',
    accountId: 'account-voice',
    chatId: 'chat-voice',
    source: 'voice',
    agentId: 'agent-jarvis',
    identityVersion: 1,
    profileRevisionId: 'profile-voice',
    status: 'running',
    model: {
      providerId: 'openai-api',
      modelId: 'gpt-5.5',
      connectionId: 'connection-voice',
      connectionMode: 'native-api',
      capabilities: { tools: false, vision: false },
      effectiveTemperature: 0.2,
      capturedAt: 90,
    },
    createdAt: 100,
    updatedAt: 100,
    transportAttempts: [
      {
        schemaVersion: 1,
        attemptNumber: 1,
        kind: 'initial',
        requestId: 'request-voice',
        state: 'provider_in_flight',
        startedEventSeq: 1,
        effectBarrier: { state: 'open', version: 0, updatedAt: 100 },
        createdAt: 100,
        updatedAt: 100,
      },
    ],
  };

  function voiceRows(engineKind: 'tts' | 'playback'): JarvisEvent[] {
    const eventType = engineKind === 'tts' ? 'model' : 'terminal';
    const producerIdentity = {
      producerKind: 'voice' as const,
      sessionId: 'vsession-voice',
      engineKind,
      executionId: `voice-${engineKind}-execution`,
    };
    return [
      {
        runId: run.id,
        seq: 2,
        idempotencyKey: `voice-${engineKind}-start:${run.id}`,
        type: eventType,
        status: 'running',
        title: engineKind === 'tts' ? 'Voice synthesis started' : 'Voice playback started',
        safeSummary: 'A voice response phase started.',
        sourceRefs: [],
        artifactIds: [],
        createdAt: 200,
        producerSourceEvidence: {
          schemaVersion: 1,
          accountId: run.accountId,
          runId: run.id,
          requestId: 'request-voice',
          attemptNumber: 1,
          producerKind: 'voice',
          producerIdentity,
          resultRef: `voice-${engineKind}-start-ref`,
          observedAt: 200,
          phase: 'start',
          state: 'started',
        },
      },
      {
        runId: run.id,
        seq: 3,
        idempotencyKey: `voice-${engineKind}-result:${run.id}`,
        type: eventType,
        status: 'completed',
        title: engineKind === 'tts' ? 'Voice synthesis completed' : 'Voice playback completed',
        safeSummary: 'A voice response phase completed.',
        sourceRefs: [],
        artifactIds: [],
        createdAt: 300,
        producerSourceEvidence: {
          schemaVersion: 1,
          accountId: run.accountId,
          runId: run.id,
          requestId: 'request-voice',
          attemptNumber: 1,
          producerKind: 'voice',
          producerIdentity,
          resultRef: `voice-${engineKind}-result-ref`,
          observedAt: 300,
          phase: 'result',
          state: 'completed',
        },
      },
    ];
  }

  function verifierFor(events: JarvisEvent[], candidateRun: JarvisRun = run) {
    return createJarvisVoiceLiveEvidenceVerifier({
      runs: { getById: vi.fn(async () => structuredClone(candidateRun)) } as never as JarvisRunRepository,
      events: {
        getBySeq: vi.fn(async (_accountId, _runId, seq) =>
          structuredClone(events.find((event) => event.seq === seq)),
        ),
        listByRun: vi.fn(async (_accountId, _runId, options) => {
          if (options.limit > 500) throw new Error('invalid_limit');
          return structuredClone(events.filter((event) => event.seq > options.afterSeq).slice(0, options.limit));
        }),
      } as never as JarvisEventRepository,
    });
  }

  it('accepts a persisted provider start for a voice run without transport attempts', async () => {
    const voiceRun: JarvisRun = { ...run, transportAttempts: undefined };
    const events = voiceRows('tts');
    const providerStart: JarvisEvent = {
      runId: run.id,
      seq: 1,
      idempotencyKey: 'provider-start:request-voice',
      type: 'model',
      status: 'started',
      title: 'Model response started',
      sourceRefs: [],
      artifactIds: [],
      createdAt: 150,
      producerSourceEvidence: {
        schemaVersion: 1,
        accountId: run.accountId,
        runId: run.id,
        requestId: 'request-voice',
        attemptNumber: 1,
        producerKind: 'provider',
        producerIdentity: {
          producerKind: 'provider',
          providerId: 'openai-api',
          modelId: 'gpt-5.5',
          modelSnapshotRef: 'model-snapshot-voice',
        },
        resultRef: 'provider-start-ref',
        observedAt: 150,
        phase: 'start',
        state: 'started',
      },
    };
    const evidence: JarvisCanonicalLiveProducerEvidence<'voice'> = {
      schemaVersion: 1,
      producerKind: 'voice',
      producerIdentity: events[0]!.producerSourceEvidence!.producerIdentity as Extract<
        JarvisEvent['producerSourceEvidence'],
        { producerKind: 'voice' }
      >['producerIdentity'],
      accountId: run.accountId,
      runId: run.id,
      requestId: 'request-voice',
      attemptNumber: 1,
      resultRef: 'voice-tts-start-ref',
      resultEventSeq: 2,
      state: 'busy',
      verifiedAt: 200,
    };
    const withStart = verifierFor([providerStart, ...events], voiceRun);
    const release = withStart.authorizeStart(
      events[0]!.producerSourceEvidence as Extract<
        JarvisEvent['producerSourceEvidence'],
        { producerKind: 'voice' }
      >,
    );
    await expect(withStart.verify(evidence)).resolves.toEqual(evidence);
    release();

    const withoutStart = verifierFor(events, voiceRun);
    const releaseWithoutStart = withoutStart.authorizeStart(
      events[0]!.producerSourceEvidence as Extract<
        JarvisEvent['producerSourceEvidence'],
        { producerKind: 'voice' }
      >,
    );
    await expect(withoutStart.verify(evidence)).resolves.toBeNull();
    releaseWithoutStart();
  });

  it.each([
    ['tts', 'model'],
    ['playback', 'terminal'],
  ] as const)(
    'revalidates exact %s start and result source pairs after a fresh boot',
    async (engineKind, eventType) => {
      const events = voiceRows(engineKind);
      expect(events.map((event) => event.type)).toEqual([eventType, eventType]);
      const identity = events[0]!.producerSourceEvidence!.producerIdentity;
      const busy: JarvisCanonicalLiveProducerEvidence<'voice'> = {
        schemaVersion: 1,
        producerKind: 'voice',
        producerIdentity: identity as Extract<typeof identity, { producerKind: 'voice' }>,
        accountId: run.accountId,
        runId: run.id,
        requestId: 'request-voice',
        attemptNumber: 1,
        resultRef: `voice-${engineKind}-start-ref`,
        resultEventSeq: 2,
        state: 'busy',
        verifiedAt: 200,
      };
      const completed: JarvisCanonicalLiveProducerEvidence<'voice'> = {
        ...busy,
        resultRef: `voice-${engineKind}-result-ref`,
        resultEventSeq: 3,
        state: 'completed',
        verifiedAt: 300,
      };

      const activeVerifier = verifierFor(events);
      const release = activeVerifier.authorizeStart(
        events[0]!.producerSourceEvidence as Extract<
          JarvisEvent['producerSourceEvidence'],
          { producerKind: 'voice' }
        >,
      );
      await expect(activeVerifier.verify(busy)).resolves.toEqual(busy);
      release();
      await expect(activeVerifier.verify(busy)).resolves.toBeNull();
      const freshVerifier = verifierFor(structuredClone(events));
      await expect(freshVerifier.verify(busy)).resolves.toBeNull();
      const verified = await freshVerifier.verify(completed);
      expect(verified).toEqual(completed);
      expect(Object.isFrozen(verified)).toBe(true);
      expect(JSON.stringify(events)).not.toMatch(/transcript|audio|spokenText|prompt/i);
    },
  );

  it('reads voice result evidence across the repository 500-row page boundary', async () => {
    const [start, result] = voiceRows('tts');
    const filler: JarvisEvent[] = Array.from({ length: 500 }, (_, index) => ({
      ...start!,
      seq: index + 2,
      idempotencyKey: `voice-filler-${index}`,
      type: 'context',
      status: 'completed',
      producerSourceEvidence: undefined,
    }));
    const pagedStart = { ...start!, seq: 502 };
    const pagedResult = { ...result!, seq: 503 };
    const source = pagedResult.producerSourceEvidence as Extract<
      JarvisEvent['producerSourceEvidence'],
      { producerKind: 'voice' }
    >;
    const evidence: JarvisCanonicalLiveProducerEvidence<'voice'> = {
      schemaVersion: 1,
      producerKind: 'voice',
      producerIdentity: source.producerIdentity,
      accountId: run.accountId,
      runId: run.id,
      requestId: 'request-voice',
      attemptNumber: 1,
      resultRef: source.resultRef,
      resultEventSeq: 503,
      state: 'completed',
      verifiedAt: 300,
    };
    await expect(verifierFor([...filler, pagedStart, pagedResult]).verify(evidence)).resolves.toEqual(
      evidence,
    );
  });

  it('rejects an ordinary status or the wrong voice producer member', async () => {
    const events = voiceRows('tts');
    const source = events[1]!.producerSourceEvidence!;
    const evidence: JarvisCanonicalLiveProducerEvidence<'voice'> = {
      schemaVersion: 1,
      producerKind: 'voice',
      producerIdentity: source.producerIdentity as Extract<
        typeof source.producerIdentity,
        { producerKind: 'voice' }
      >,
      accountId: run.accountId,
      runId: run.id,
      requestId: 'request-voice',
      attemptNumber: 1,
      resultRef: source.resultRef,
      resultEventSeq: 3,
      state: 'completed',
      verifiedAt: 300,
    };

    const ordinaryStatus = structuredClone(events);
    ordinaryStatus[1] = { ...ordinaryStatus[1]!, status: 'running' };
    await expect(verifierFor(ordinaryStatus).verify(evidence)).resolves.toBeNull();

    const wrongProducer: JarvisCanonicalLiveProducerEvidence<'voice'> = {
      ...structuredClone(evidence),
      producerIdentity: {
        ...evidence.producerIdentity,
        executionId: 'voice-other-execution',
      },
    };
    await expect(verifierFor(events).verify(wrongProducer)).resolves.toBeNull();
  });
});
