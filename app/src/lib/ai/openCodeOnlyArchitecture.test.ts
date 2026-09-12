import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const router = readFileSync(resolve(process.cwd(), 'src/lib/ai/router.ts'), 'utf8');

describe('OpenCode-only production routing architecture', () => {
  it('does not load ordinary native provider executors into the production router', () => {
    expect(router).not.toMatch(
      /from ['"]\.\/providers\/(?:anthropic|openai|google|groq|ollama|compatibleInstances|mock)['"]/u,
    );
    expect(router).not.toMatch(/\bproviders\s*:\s*Record<ProviderId,\s*LLMProvider>/u);
  });

  it('does not load ordinary external provider CLI executors into the production router', () => {
    expect(router).not.toMatch(
      /from ['"]\.\/adapters\/(?:codex|claude|gemini|copilot|qwen|opencode)['"]/u,
    );
    expect(router).not.toContain('export async function runExternalConnection');
    expect(router).not.toContain("'adapter-authentication'");
  });

  it('keeps one ordinary OpenCode dispatch and an explicit smoke-only exception', () => {
    const dispatch = router.slice(
      router.indexOf('async function runAgentDispatch'),
      router.indexOf('export async function runAgent'),
    );
    expect(dispatch).toContain(
      'if (KERNEL_SMOKE_ENABLED && req.agent.model.provider === KERNEL_SMOKE_PROVIDER_ID)',
    );
    expect(dispatch.match(/dispatchThroughOpenCode\(req\)/gu)).toHaveLength(1);
    expect(dispatch).not.toMatch(/provider\.run|adapter\.send|runExternalConnection/u);
  });
});
