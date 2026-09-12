import { describe, expect, it } from 'vitest';
import {
  createBrowserNativeHandoffRuntime,
  type BrowserNativeHandoffRequest,
  type BrowserNativeHandoffStorage,
} from './browserNativeHandoff';

function setup() {
  const values = new Map<string, string>();
  const storage: BrowserNativeHandoffStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
  let now = 1_100;
  const runtime = createBrowserNativeHandoffRuntime({
    storage,
    now: () => now,
    hash: async (text) => [...text].reduce(
      (hash, character) => ((hash * 33) ^ character.charCodeAt(0)) >>> 0,
      5381,
    ).toString(16).padStart(64, '0'),
  });
  const request: BrowserNativeHandoffRequest = {
    accountId: 'account-1',
    projectId: 'project-1',
    runId: 'run-1',
    chatId: 'chat-1',
    providerId: 'openai',
    modelId: 'gpt-5',
    connectionId: 'connection-1',
    browserOrigin: 'https://example.test',
    browserTabId: 'tab-1',
    approvalId: 'approval-1',
    reviewId: 'review-1',
    visiblePrompt: 'Summarize the approved report.',
    purpose: 'Create the reviewed summary artifact.',
    attachments: [{
      attachmentRef: 'jattachment_report_1',
      name: 'report.pdf',
      mediaType: 'application/pdf',
      sizeBytes: 10,
      sha256: 'a'.repeat(64),
      trust: 'user_approved',
    }],
    expectedArtifact: {
      schemaId: 'summary-v1',
      mediaType: 'application/json',
      maximumBytes: 2_000,
    },
    checkpointSequence: 3,
    issuedAt: 1_000,
    expiresAt: 2_000,
    idempotencyKey: 'handoff-attempt-1',
  };
  return { runtime, request, values, setNow: (value: number) => void (now = value) };
}

describe('browser-native handoff contract', () => {
  it('issues only the exact approved prompt, attachment metadata, and bound authority', async () => {
    const { runtime, request, values } = setup();
    const envelope = await runtime.issue(request);

    expect(envelope).toMatchObject({
      schemaVersion: 1,
      accountId: 'account-1',
      projectId: 'project-1',
      checkpointSequence: 3,
      trust: 'user_approved',
    });
    expect(JSON.stringify(envelope)).not.toContain('content');
    expect(JSON.stringify([...values.values()])).not.toContain('password');
  });

  it('rejects hidden fields, raw credentials, unapproved attachment data, and oversized output', async () => {
    const { runtime, request } = setup();
    await expect(runtime.issue({
      ...request,
      hiddenHistory: ['secret'],
    } as BrowserNativeHandoffRequest)).rejects.toThrow('request');
    await expect(runtime.issue({
      ...request,
      visiblePrompt: 'Use api_key=raw-secret-value',
    })).rejects.toThrow('credentials');
    await expect(runtime.issue({
      ...request,
      attachments: [{ ...request.attachments[0]!, content: 'raw bytes' }] as unknown as typeof request.attachments,
    })).rejects.toThrow('attachment');

    const envelope = await runtime.issue(request);
    await expect(runtime.accept(envelope, {
      handoffId: envelope.handoffId,
      bindingHash: envelope.bindingHash,
      checkpointSequence: envelope.checkpointSequence,
      schemaId: 'summary-v1',
      artifactRef: 'jresult_summary_1',
      evidenceRef: 'jlive_summary_1',
      artifactHash: 'b'.repeat(64),
      artifactBytes: 2_001,
      trust: 'external_untrusted',
    }, 1_200)).rejects.toThrow('validation');
  });

  it('settles canonical refs idempotently and rejects replay, scope drift, and prose completion', async () => {
    const { runtime, request } = setup();
    const envelope = await runtime.issue(request);
    const returned = {
      handoffId: envelope.handoffId,
      bindingHash: envelope.bindingHash,
      checkpointSequence: envelope.checkpointSequence,
      schemaId: 'summary-v1',
      artifactRef: 'jresult_summary_1',
      evidenceRef: 'jlive_summary_1',
      artifactHash: 'b'.repeat(64),
      artifactBytes: 100,
      trust: 'external_untrusted' as const,
    };
    const first = await runtime.accept(envelope, returned, 1_200);
    await expect(runtime.accept(envelope, returned, 1_200)).resolves.toEqual(first);
    await expect(runtime.accept(envelope, {
      ...returned,
      artifactRef: 'jresult_summary_2',
    }, 1_200)).rejects.toThrow('replay');
    await expect(runtime.accept(
      { ...envelope, projectId: 'project-2' },
      returned,
      1_200,
    )).rejects.toThrow();
    await expect(runtime.accept(envelope, {
      ...returned,
      completion: 'done',
    } as typeof returned, 1_200)).rejects.toThrow('return');
    expect(first).toMatchObject({
      artifactRef: 'jresult_summary_1',
      evidenceRef: 'jlive_summary_1',
      trust: 'external_untrusted',
      completionAuthority: 'none',
    });
  });

  it('recovers issued authority durably and rejects expired issuance', async () => {
    const { runtime, request, setNow } = setup();
    const envelope = await runtime.issue(request);
    await expect(runtime.recover('account-1', 'project-1', 'handoff-attempt-1'))
      .resolves.toEqual(envelope);
    setNow(2_001);
    await expect(runtime.issue({ ...request, idempotencyKey: 'handoff-attempt-2' }))
      .rejects.toThrow('expired');
  });
});
