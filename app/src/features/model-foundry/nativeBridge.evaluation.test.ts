import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('../../lib/utils', () => ({ isTauri: true }));
import { evaluateFoundryArtifact, type FoundryPrivateEvaluationCase } from './nativeBridge';

const manifest = 'a'.repeat(64);
const job = { id: 'candidate', projectId: 'project', name: 'Candidate', version: 1,
  method: 'full', status: 'completed', artifactVerified: true, artifactSha256: manifest };
const sample: FoundryPrivateEvaluationCase = { id: 'case', prompt: 'Say blue.', expectedCompletion: 'blue', hidden: true };
const args = { projectId: 'project', jobId: 'candidate', cases: [sample] };

describe('measured Foundry evaluation boundaries', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'model_foundry_list_jobs') return [{ ...job }];
      if (command === 'model_foundry_chat') return { artifactId: job.id, modelName: job.name,
        version: 1, method: 'full', text: 'blue', inputTokens: 3, outputTokens: 1 };
      throw new Error(`Unexpected native command: ${command}`);
    });
  });

  it('keeps measured candidate evidence without inventing comparison or promotion approval', async () => {
    const result = await evaluateFoundryArtifact(args);
    expect(result.artifactManifestSha256).toBe(manifest);
    expect(result.report).toMatchObject({ baseScore: null, candidateScore: 1, championScore: null,
      delta: null, gate: 'blocked', caseCount: 1 });
    expect(result.report.caseEvidence[0]).toMatchObject({ baseScore: null, candidateScore: 1, championScore: null, hidden: true });
    expect(result.report.caseEvidence[0]?.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain(sample.prompt);
  });

  it('aggregates the measured per-case scores rather than inflating partial matches to full credit', async () => {
    const result = await evaluateFoundryArtifact({ ...args, cases: [{ ...sample, expectedCompletion: 'blue sky' }] });
    expect(result.report.caseEvidence[0]?.candidateScore).toBe(0.5);
    expect(result.report.candidateScore).toBe(0.5);
  });

  it('rejects an unsupported requested champion comparison before any native effect', async () => {
    await expect(evaluateFoundryArtifact({ ...args, championJobId: 'champion' })).rejects.toThrow(/champion.*not available/i);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'no cases', cases: [] },
    { name: 'blank expected completion', cases: [{ ...sample, expectedCompletion: ' ' }] },
    { name: 'blank prompt', cases: [{ ...sample, prompt: ' ' }] },
    { name: 'duplicate IDs', cases: [sample, { ...sample }] },
    { name: 'overlong prompt', cases: [{ ...sample, prompt: 'x'.repeat(16_385) }] },
  ])('rejects $name before native IO', async ({ cases }) => {
    await expect(evaluateFoundryArtifact({ ...args, cases })).rejects.toThrow(/case/i);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, 33, NaN])('rejects invalid maximum %s before native IO', async (maxCases) => {
    await expect(evaluateFoundryArtifact({ ...args, maxCases })).rejects.toThrow(/case/i);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'foreign project', patch: { projectId: 'foreign' } },
    { name: 'unverified', patch: { artifactVerified: false } },
    { name: 'not completed', patch: { status: 'running' } },
    { name: 'missing hash', patch: { artifactSha256: null } },
  ])('rejects $name before inference', async ({ patch }) => {
    invokeMock.mockResolvedValueOnce([{ ...job, ...patch }]);
    await expect(evaluateFoundryArtifact(args)).rejects.toThrow(/artifact|verified/i);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('rejects verification revocation while a case was running', async () => {
    let listed = 0;
    const original = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (command: string, params: unknown) => {
      if (command === 'model_foundry_list_jobs' && ++listed > 1) return [{ ...job, artifactVerified: false }];
      return original(command, params);
    });
    await expect(evaluateFoundryArtifact(args)).rejects.toThrow(/verified|artifact/i);
  });

  it('rejects a changed artifact hash instead of combining different artifact evidence', async () => {
    let listed = 0;
    const original = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (command: string, params: unknown) => {
      if (command === 'model_foundry_list_jobs' && ++listed > 1) return [{ ...job, artifactSha256: 'b'.repeat(64) }];
      return original(command, params);
    });
    await expect(evaluateFoundryArtifact(args)).rejects.toThrow(/changed|artifact/i);
  });
});
