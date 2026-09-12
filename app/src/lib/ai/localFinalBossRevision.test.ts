import { describe, expect, it, vi } from 'vitest';
import type { AgentId } from '@/types/common';
import type { RunAgentRequest } from './router';
import {
  runBoundedLocalFinalBossRevision,
  selectHigherQualityFinalBossCandidate,
  shouldRunLocalFinalBossRevision,
} from './localFinalBossRevision';

describe('runBoundedLocalFinalBossRevision', () => {
  it('is limited to local Final Boss turns', () => {
    expect(shouldRunLocalFinalBossRevision('token-final-boss', 'ollama')).toBe(true);
    expect(shouldRunLocalFinalBossRevision('token-final-boss', 'local')).toBe(true);
    expect(shouldRunLocalFinalBossRevision('normal', 'ollama')).toBe(false);
    expect(shouldRunLocalFinalBossRevision('token-final-boss', 'openai')).toBe(false);
  });

  it('keeps a more complete valid PowerShell draft instead of a degraded revision', () => {
    const request =
      'PowerShell JSON notes CLI with path containment, atomic writes, concurrency, tests, and verification.';
    const draft =
      'Path containment uses GetFullPath. Atomic writes use a temporary file and Move-Item. Concurrency uses a named mutex. Tests and verification cover recovery.';
    const degraded =
      'Use [Transaction], Test-Script, and Get-Content -FilePath. Verification complete.';
    expect(selectHigherQualityFinalBossCandidate(request, draft, degraded)).toBe('draft');
  });

  it('selects a revision that covers requirements the draft omitted', () => {
    const request =
      'PowerShell JSON notes CLI with path containment, atomic writes, concurrency, tests, and verification.';
    const draft = 'Create a PowerShell JSON notes CLI.';
    const revision =
      'Create a PowerShell JSON notes CLI. Path containment uses GetFullPath. Atomic writes use a temporary file and Move-Item. Concurrency uses a named mutex. Tests and verification cover recovery.';
    expect(selectHigherQualityFinalBossCandidate(request, draft, revision)).toBe('revision');
  });

  it('keeps the draft private, streams one corrected revision, and combines usage', async () => {
    const streamed: string[] = [];
    const request = {
      agent: {
        id: 'agent_test' as AgentId,
        slug: 'jarvis',
        name: 'Jarvis',
        description: 'Test',
        system_prompt: 'Be accurate.',
        model: { provider: 'ollama', model: 'llama3.2:latest' },
        tools_allowed: [],
        memory_scope: 'workspace',
        capabilities: [],
        builtin: true,
        created_at: 1,
        updated_at: 1,
      },
      messages: [{ role: 'user', content: 'Design a safe notes CLI.' }],
      max_output_tokens: 8192,
      onChunk: (chunk) => {
        if (chunk.delta) streamed.push(chunk.delta);
      },
    } satisfies RunAgentRequest;
    const run = vi
      .fn<
        (
          _: RunAgentRequest,
        ) => Promise<Awaited<ReturnType<typeof runBoundedLocalFinalBossRevision>>>
      >()
      .mockResolvedValueOnce({
        text: 'draft with invalid APIs',
        usage: { input_tokens: 10, output_tokens: 20, cost_usd: 0 },
        provider: 'ollama',
        model: 'llama3.2:latest',
      })
      .mockImplementationOnce(async (revisionRequest) => {
        return {
          text: 'verified revision with safe notes CLI verification',
          usage: { input_tokens: 30, output_tokens: 40, cost_usd: 0 },
          provider: 'ollama',
          model: 'llama3.2:latest',
        };
      });

    const response = await runBoundedLocalFinalBossRevision(run, request);

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]![0].onChunk).toBeUndefined();
    expect(run.mock.calls[1]![0].onChunk).toBeUndefined();
    expect(run.mock.calls[1]![0].messages).toEqual([
      ...request.messages,
      { role: 'assistant', content: 'draft with invalid APIs' },
      expect.objectContaining({
        role: 'user',
        content: expect.stringContaining('Return only the corrected final answer'),
      }),
    ]);
    expect(streamed).toEqual(['verified revision with safe notes CLI verification']);
    expect(response).toEqual({
      text: 'verified revision with safe notes CLI verification',
      usage: { input_tokens: 40, output_tokens: 60, cost_usd: 0 },
      provider: 'ollama',
      model: 'llama3.2:latest',
    });
  });

  it('restores an unambiguous exact literal without adding a third provider call', async () => {
    const streamed: string[] = [];
    const request = {
      agent: {
        id: 'agent_test' as AgentId,
        slug: 'jarvis',
        name: 'Jarvis',
        description: 'Test',
        system_prompt: 'Be accurate.',
        model: { provider: 'ollama', model: 'llama3.2:latest' },
        tools_allowed: [],
        memory_scope: 'workspace',
        capabilities: [],
        builtin: true,
        created_at: 1,
        updated_at: 1,
      },
      messages: [
        {
          role: 'user',
          content: 'Return exactly FINAL_BOSS_OK after checking your answer twice.',
        },
      ],
      max_output_tokens: 8192,
      onChunk: (chunk) => {
        if (chunk.delta) streamed.push(chunk.delta);
      },
    } satisfies RunAgentRequest;
    const response = {
      text: 'FINAL BOSS OK!',
      usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0 },
      provider: 'ollama',
      model: 'llama3.2:latest',
    };
    const run = vi.fn().mockResolvedValueOnce(response).mockResolvedValueOnce(response);

    await expect(runBoundedLocalFinalBossRevision(run, request)).resolves.toMatchObject({
      text: 'FINAL_BOSS_OK',
    });
    expect(streamed).toEqual(['FINAL_BOSS_OK']);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('returns the completed draft when the private verifier is unavailable', async () => {
    const streamed: string[] = [];
    const request = {
      agent: {
        id: 'agent_test' as AgentId,
        slug: 'jarvis',
        name: 'Jarvis',
        description: 'Test',
        system_prompt: 'Be accurate.',
        model: { provider: 'ollama', model: 'llama3.2:latest' },
        tools_allowed: [],
        memory_scope: 'workspace',
        capabilities: [],
        builtin: true,
        created_at: 1,
        updated_at: 1,
      },
      messages: [{ role: 'user', content: 'Design a safe notes CLI.' }],
      max_output_tokens: 8192,
      onChunk: (chunk) => {
        if (chunk.delta) streamed.push(chunk.delta);
      },
    } satisfies RunAgentRequest;
    const draft = {
      text: 'complete safe draft',
      usage: { input_tokens: 10, output_tokens: 20, cost_usd: 0 },
      provider: 'ollama',
      model: 'llama3.2:latest',
    };
    const run = vi.fn().mockResolvedValueOnce(draft).mockRejectedValueOnce(new Error('offline'));

    await expect(runBoundedLocalFinalBossRevision(run, request)).resolves.toEqual(draft);
    expect(streamed).toEqual(['complete safe draft']);
  });
});
