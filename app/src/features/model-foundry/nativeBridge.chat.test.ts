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
