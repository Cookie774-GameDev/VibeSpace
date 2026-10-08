import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('../../lib/utils', () => ({ isTauri: true }));

import { generateFromFoundryArtifact, evaluateFoundryArtifact } from './nativeBridge';

describe('Model Foundry native chat bridge', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'model_foundry_chat') {
        return {
          artifactId: 'job_0-vjmMedLqAeGX',
          modelName: 'N13 smoke test',
          version: 1,
          method: 'full',
          text: 'A locally generated counterargument.',
          inputTokens: 21,
          outputTokens: 6,
        };
      }
      if (command === 'model_foundry_list_jobs') {
        return [
          {
            id: 'job_0-vjmMedLqAeGX',
            name: 'N13 smoke test',
            version: 1,
            method: 'full',
            status: 'completed',
            artifactVerified: true,
            artifactSha256: 'e'.repeat(64),
          },
        ];
      }
      throw new Error(`Unexpected native command: ${command}`);
    });
  });

  it('keeps the private-case evaluator consuming text from the measured chat receipt', async () => {
    const report = await evaluateFoundryArtifact({
      projectId: 'artifact',
      jobId: 'job_0-vjmMedLqAeGX',
      cases: [
        { id: 'public-case', prompt: 'A public test.', expectedCompletion: 'counterargument' },
      ] as never,
    });
    expect(report.report.caseCount).toBe(1);
  });

  it('sends the saved artifact directly to native inference without a duplicate prepare pass', async () => {
    const result = await generateFromFoundryArtifact({
      projectId: 'artifact',
      jobId: 'job_0-vjmMedLqAeGX',
      prompt:
        'Compare both sides of the transit debate.\n\nUSER: Should cities prioritize buses or protected bike lanes?\n\nASSISTANT:',
      maxNewTokens: 320,
    });

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenNthCalledWith(
      1,
      'model_foundry_chat',
      expect.objectContaining({
        artifactId: 'job_0-vjmMedLqAeGX',
        messages: [
          {
            role: 'user',
            content: expect.stringContaining(
              'Should cities prioritize buses or protected bike lanes?',
            ),
          },
        ],
        maxOutputTokens: 320,
      }),
    );
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'model_foundry_list_jobs', undefined);
    expect(invokeMock).not.toHaveBeenCalledWith('model_foundry_prepare_chat', expect.anything());
    expect(result).toMatchObject({
      text: 'A locally generated counterargument.',
      artifactManifestSha256: 'e'.repeat(64),
      inputTokens: 21,
      outputTokens: 6,
    });
  });

  it('rejects a response from another artifact instead of binding it to the selected model', async () => {
    invokeMock.mockResolvedValueOnce({
      artifactId: 'different-job',
      modelName: 'Other model',
      version: 1,
      method: 'full',
      text: 'Wrong model.',
      inputTokens: 2,
      outputTokens: 2,
    });
    await expect(
      generateFromFoundryArtifact({
        projectId: 'artifact',
        jobId: 'job_0-vjmMedLqAeGX',
        prompt: 'A public test.',
      }),
    ).rejects.toThrow(/mismatched|incomplete/i);
  });

  it('rejects a job whose verification is revoked after inference', async () => {
    invokeMock.mockImplementation(async (command: string) =>
      command === 'model_foundry_chat'
        ? {
            artifactId: 'job_0-vjmMedLqAeGX',
            modelName: 'N13 smoke test',
            version: 1,
            method: 'full',
            text: 'Local answer.',
            inputTokens: 2,
            outputTokens: 2,
          }
        : [{ id: 'job_0-vjmMedLqAeGX', artifactVerified: false }],
    );
    await expect(
      generateFromFoundryArtifact({
        projectId: 'artifact',
        jobId: 'job_0-vjmMedLqAeGX',
        prompt: 'A public test.',
      }),
    ).rejects.toThrow(/verified|mismatched/i);
  });

  it('forwards structured chat roles so the user-query guard sees only the actual user turn', async () => {
    const systemPrompt = 'Follow the saved agent instructions carefully. '.repeat(120);
    const messages = [
      { role: 'system' as const, content: systemPrompt },
      { role: 'assistant' as const, content: 'Earlier response.' },
      { role: 'user' as const, content: 'Compare both sides and recommend one.' },
    ];
    const prompt = messages
      .map(({ role, content }) => `${role.toUpperCase()}: ${content}`)
      .join('\n\n');

    await generateFromFoundryArtifact({
      projectId: 'artifact',
      jobId: 'job_0-vjmMedLqAeGX',
      prompt,
      messages,
      maxNewTokens: 320,
    });

    expect(invokeMock).toHaveBeenNthCalledWith(
      1,
      'model_foundry_chat',
      expect.objectContaining({ messages }),
    );
    expect(messages.at(-1)?.content.length).toBeLessThan(4_000);
    expect(messages[0]?.content.length).toBeGreaterThan(4_000);
  });
});

// Inspect the real local recorder/projection. The only injected boundary is native IPC.
import { appActivityLog } from '@/lib/diagnostics/appActivityLog';
import { toPersistedActivity } from '@/lib/diagnostics/activityLogPersistence';
import { optionalActivityEvent } from '@/features/telemetry/telemetryExporter';
import { createAppDiagnosticsCollector } from '@/features/telemetry/appDiagnostics';

const diagnosticCorrelation = {
  runId: 'jrun_11111111-1111-4111-8111-111111111111',
  requestId: 'jreq_22222222-2222-4222-8222-222222222222',
  attemptNumber: 2,
};
const diagnosticRequest = () => ({
  projectId: 'artifact', jobId: 'job_0-vjmMedLqAeGX',
  prompt: 'PRIVATE_PROMPT_DO_NOT_LOG',
  messages: [{ role: 'user' as const, content: 'PRIVATE_PROMPT_DO_NOT_LOG' }],
  correlation: diagnosticCorrelation,
});
const diagnosticResponse = () => ({ artifactId: 'job_0-vjmMedLqAeGX', modelName: 'PRIVATE_MODEL_NAME',
  version: 1, method: 'full', text: 'PRIVATE_OUTPUT_DO_NOT_LOG', inputTokens: 2, outputTokens: 3 });
const diagnosticJobs = () => [{ id: 'job_0-vjmMedLqAeGX', name: 'PRIVATE_MODEL_NAME', version: 1,
  method: 'full', status: 'completed', artifactVerified: true, artifactSha256: 'e'.repeat(64) }];
const inferenceEvents = (after: number) => appActivityLog.snapshot(after).events.filter((event) => event.kind === 'foundry.inference.native');

function assertMetadataOnly(events: ReturnType<typeof inferenceEvents>) {
  const serialized = JSON.stringify(events);
  for (const privateText of ['PRIVATE_PROMPT', 'PRIVATE_OUTPUT', 'PRIVATE_MODEL_NAME', 'PRIVATE_NATIVE_ERROR', 'private-account'])
    expect(serialized).not.toContain(privateText);
  for (const event of events) {
    expect(Object.keys(event.data as object).sort()).toEqual(
      ['attemptNumber', 'callId', 'eventType', 'model', 'provider', 'requestId', 'runId'].sort(),
    );
    expect(optionalActivityEvent(event, { appVersion: '1.5.0', platform: 'windows' })).toBeNull();
  }
}

describe('local-only Foundry inference correlation', () => {
  beforeEach(async () => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'model_foundry_chat') return diagnosticResponse();
      if (command === 'model_foundry_list_jobs') return diagnosticJobs();
      if (command === 'model_foundry_cancel_chat') return true;
      throw new Error('Unexpected synthetic command');
    });
    // Resolve the mocked native module before deliberately concurrent imports.
    await import('@tauri-apps/api/core');
  });

  it('joins the protected run to the exact native call ID in durable-safe metadata', async () => {
    const after = appActivityLog.snapshot().sequence;
    await generateFromFoundryArtifact(diagnosticRequest());
    const nativeCall = invokeMock.mock.calls.find(([command]) => command === 'model_foundry_chat')?.[1];
    const events = inferenceEvents(after);
    expect(events.map((event) => event.phase)).toEqual(['started', 'completed']);
    expect(events[0]?.operationId).toBe(events[1]?.operationId);
    for (const event of events) {
      expect(event.data).toMatchObject({ ...diagnosticCorrelation, callId: nativeCall.requestId,
        provider: 'foundry', model: 'artifact--job_0-vjmMedLqAeGX' });
      expect(toPersistedActivity(event)).toMatchObject({ callId: nativeCall.requestId,
        runId: diagnosticCorrelation.runId, requestId: diagnosticCorrelation.requestId });
    }
    expect(events[1]?.durationMs).toBeGreaterThanOrEqual(0);
    assertMetadataOnly(events);
  });

  it('records a fixed rejection category without copying the native error body', async () => {
    const failure = new Error('PRIVATE_NATIVE_ERROR C:/private-account/secret-file');
    invokeMock.mockRejectedValueOnce(failure);
    const after = appActivityLog.snapshot().sequence;
    await expect(generateFromFoundryArtifact(diagnosticRequest())).rejects.toBe(failure);
    const events = inferenceEvents(after);
    expect(events.map((event) => event.phase)).toEqual(['started', 'failed']);
    expect(events[1]?.data).toMatchObject({ eventType: 'native-rejected' });
    assertMetadataOnly(events);
  });

  it('labels invalid response evidence separately and never logs its output', async () => {
    invokeMock.mockResolvedValueOnce({ ...diagnosticResponse(), artifactId: 'wrong-job' });
    const after = appActivityLog.snapshot().sequence;
    await expect(generateFromFoundryArtifact(diagnosticRequest())).rejects.toThrow(/mismatched|incomplete/i);
    const events = inferenceEvents(after);
    expect(events.map((event) => event.phase)).toEqual(['started', 'failed']);
    expect(events[1]?.data).toMatchObject({ eventType: 'response-invalid' });
    assertMetadataOnly(events);
  });

  it('waits for the original IPC to settle and labels a late success after abort as cancelled', async () => {
    let finish!: (response: ReturnType<typeof diagnosticResponse>) => void;
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'model_foundry_chat') return new Promise((resolve) => { finish = resolve; });
      if (command === 'model_foundry_cancel_chat') return true;
      throw new Error('Unexpected synthetic command');
    });
    const controller = new AbortController();
    const after = appActivityLog.snapshot().sequence;
    const result = generateFromFoundryArtifact({ ...diagnosticRequest(), signal: controller.signal }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    controller.abort();
    await vi.waitFor(() => expect(invokeMock.mock.calls.some(([name]) => name === 'model_foundry_cancel_chat')).toBe(true));
    expect(inferenceEvents(after).map((event) => event.phase)).toEqual(['started']);
    finish(diagnosticResponse());
    expect(await result).toMatchObject({ name: 'AbortError' });
    const events = inferenceEvents(after);
    expect(events.map((event) => event.phase)).toEqual(['started', 'cancelled']);
    expect(events[1]?.data).toMatchObject({ eventType: 'cancelled' });
    assertMetadataOnly(events);
  });

  it('does not dispatch inference when a synchronous diagnostic observer aborts at start', async () => {
    const controller = new AbortController();
    const after = appActivityLog.snapshot().sequence;
    const unsubscribe = appActivityLog.subscribe((event) => {
      if (event.kind === 'foundry.inference.native' && event.phase === 'started') controller.abort();
    });
    try {
      await expect(generateFromFoundryArtifact({ ...diagnosticRequest(), signal: controller.signal }))
        .rejects.toMatchObject({ name: 'AbortError' });
      expect(invokeMock.mock.calls.filter(([name]) => name === 'model_foundry_chat')).toHaveLength(0);
      expect(inferenceEvents(after).map((event) => event.phase)).toEqual(['started', 'cancelled']);
      assertMetadataOnly(inferenceEvents(after));
    } finally { unsubscribe(); }
  });

  it('does not create a native diagnostic operation for a request already aborted', async () => {
    const controller = new AbortController(); controller.abort();
    const after = appActivityLog.snapshot().sequence;
    await expect(generateFromFoundryArtifact({ ...diagnosticRequest(), signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(invokeMock).not.toHaveBeenCalled();
    expect(inferenceEvents(after)).toHaveLength(0);
  });

  it('keeps concurrent native completions joined to their own protected attempts', async () => {
    const pending: { requestId: string; resolve: (value: ReturnType<typeof diagnosticResponse>) => void;
      reject: (error: Error) => void }[] = [];
    invokeMock.mockImplementation((command: string, args?: { requestId: string }) => {
      if (command === 'model_foundry_chat') return new Promise((resolve, reject) => {
        pending.push({ requestId: args!.requestId, resolve, reject });
      });
      if (command === 'model_foundry_list_jobs') return Promise.resolve(diagnosticJobs());
      throw new Error('Unexpected synthetic command');
    });
    // Concurrent dynamic-import resolution can use the real Tauri module in Vitest.
    // Both module paths must reach the same explicitly injected native IPC boundary.
    const priorNative = Object.getOwnPropertyDescriptor(window, '__TAURI_INTERNALS__');
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke: invokeMock } });
    try {
    const after = appActivityLog.snapshot().sequence;
    const secondCorrelation = { runId: 'jrun_33333333-3333-4333-8333-333333333333',
      requestId: 'jreq_44444444-4444-4444-8444-444444444444', attemptNumber: 1 };
    const first = generateFromFoundryArtifact(diagnosticRequest()).catch((error: unknown) => error);
    const second = generateFromFoundryArtifact({ ...diagnosticRequest(), correlation: secondCorrelation }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1]!.resolve(diagnosticResponse()); expect(await second).toMatchObject({ text: 'PRIVATE_OUTPUT_DO_NOT_LOG' });
    const failure = new Error('PRIVATE_NATIVE_ERROR from first request');
    pending[0]!.reject(failure); expect(await first).toBe(failure);
    const events = inferenceEvents(after);
    expect(events).toHaveLength(4);
    expect(events.filter((event) => event.phase !== 'started').map((event) => ({
      phase: event.phase, data: event.data,
    }))).toEqual([
      { phase: 'completed', data: expect.objectContaining({ ...secondCorrelation, callId: pending[1]!.requestId }) },
      { phase: 'failed', data: expect.objectContaining({ ...diagnosticCorrelation, callId: pending[0]!.requestId }) },
    ]);
    assertMetadataOnly(events);
    } finally {
      for (const request of pending) request.resolve(diagnosticResponse());
      if (priorNative) Object.defineProperty(window, '__TAURI_INTERNALS__', priorNative);
      else Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    }
  });

  it('omits malformed correlation and path-shaped artifact values instead of logging them', async () => {
    const failure = new Error('PRIVATE_NATIVE_ERROR');
    invokeMock.mockRejectedValueOnce(failure);
    const after = appActivityLog.snapshot().sequence;
    await expect(generateFromFoundryArtifact({ ...diagnosticRequest(), jobId: 'C:/private-account/weights',
      correlation: { runId: 'private-account-value', requestId: 'PRIVATE_SECRET', attemptNumber: 1 } })).rejects.toBe(failure);
    const events = inferenceEvents(after);
    expect(events).toHaveLength(2);
    for (const event of events)
      expect(Object.keys(event.data as object).sort()).toEqual(['callId', 'eventType', 'provider']);
    expect(JSON.stringify(events)).not.toMatch(/private-account|PRIVATE_SECRET|PRIVATE_NATIVE_ERROR/);
  });

  it('does not export the new local kind through either optional telemetry projection', () => {
    const emit = vi.fn(() => true);
    let time = 0;
    const collector = createAppDiagnosticsCollector({ allowed: () => true,
      readUi: () => ({ route: 'chat', settingsOpen: false, paletteOpen: false, voiceModalOpen: false }),
      subscribeUi: () => () => {}, events: new EventTarget(), isVisible: () => true,
      readHeap: () => null, now: () => 1_800_000_000_000, monotonic: () => time,
      environment: { appVersion: '1.5.0', platform: 'windows' }, emit });
    collector.recordOperation('foundry.inference.native', 'failed', 100);
    time = 70_000; collector.sample(); collector.dispose();
    expect(emit).not.toHaveBeenCalled();
  });
});
