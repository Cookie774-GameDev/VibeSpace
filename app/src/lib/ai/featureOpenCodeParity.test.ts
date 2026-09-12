import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('PR31 OpenCode feature parity', () => {
  it('compiles VibeSpace-owned context before the canonical chat dispatch', () => {
    const runtime = source('src/lib/ai/runtime.ts');
    const contextStart = runtime.indexOf('const runtimeContextBlocks =');
    const dispatchStart = runtime.indexOf('const response = shouldRunLocalFinalBossRevision');
    expect(contextStart).toBeGreaterThan(0);
    expect(dispatchStart).toBeGreaterThan(contextStart);

    const preparation = runtime.slice(0, contextStart);
    for (const expected of [
      'getPluginContextBlock(projectId, detail.pluginIds)',
      'getSelectedSkillsBlock(detail.skillIds)',
      'buildAllAboutMeContextBlock(useAllAboutMeStore.getState().markdown)',
      'formatResolvedJarvisContext(resolvedRequestContext)',
      'getExplicitFilesBlock(',
      'getConnectedFilesBlock(agent.slug, projectId)',
    ]) {
      expect(preparation).toContain(expected);
    }

    const compiledTurn = runtime.slice(contextStart, dispatchStart);
    for (const contextKey of [
      "'all_about_me'",
      "'plugin_context'",
      "'selected_skills'",
      "'resolved_context'",
      "'explicit_context'",
      "'explicit_files'",
      "'connected_files'",
    ]) {
      expect(compiledTurn).toContain(contextKey);
    }
    expect(compiledTurn).toContain('runtimeContextBlocks.map((block) => block.text)');

    const dispatch = runtime.slice(dispatchStart, runtime.indexOf('await mirrorShadowOutcome'));
    expect(dispatch).toContain('await runAgent(providerRequest)');
    expect(dispatch).not.toMatch(/create(?:OpenAI|Anthropic|Google|Groq|Ollama)Adapter/u);
  });

  it('routes profile, learning, context maintenance, and file model turns through the router', () => {
    const featureSources = [
      'src/features/all-about-me/completion.ts',
      'src/features/context/nightlySecondBrainRuntime.ts',
      'src/features/files/FilesPage.tsx',
      'src/features/files/fileExplorerSearchRuntime.ts',
    ].map(source);

    for (const featureSource of featureSources) {
      expect(featureSource).toContain("import { runAgent } from '@/lib/ai/router'");
      expect(featureSource).toContain('await runAgent({');
      expect(featureSource).not.toMatch(/create(?:OpenAI|Anthropic|Google|Groq|Ollama)Adapter/u);
    }

    const runtime = source('src/lib/ai/runtime.ts');
    const learningStart = runtime.indexOf('async function maybeUpdateAllAboutMeFromChat');
    const learningEnd = runtime.indexOf('\nfunction ', learningStart + 1);
    expect(learningStart).toBeGreaterThan(0);
    expect(runtime.slice(learningStart, learningEnd)).toContain('await runAgent({');
  });

  it('has one production router dispatch boundary, including Model Foundry models', () => {
    const router = source('src/lib/ai/router.ts');
    const dispatch = router.slice(
      router.indexOf('async function runAgentDispatch'),
      router.indexOf('export async function runAgent'),
    );
    expect(dispatch).toContain('return dispatchThroughOpenCode(req)');
    expect(dispatch.match(/dispatchThroughOpenCode\(req\)/gu)).toHaveLength(1);
    expect(dispatch).not.toMatch(/adapter\.run|nativeInvoke|invoke\(/u);

    const openCodeDispatch = router.slice(
      router.indexOf('async function dispatchThroughOpenCode'),
      router.indexOf(
        '\nasync function ',
        router.indexOf('async function dispatchThroughOpenCode') + 1,
      ),
    );
    expect(openCodeDispatch).toContain('executePersistentOpenCode(req, selection, hooks)');

    const persistentDispatch = router.slice(
      router.indexOf('async function executePersistentOpenCode'),
      router.indexOf(
        '\nasync function ',
        router.indexOf('async function executePersistentOpenCode') + 1,
      ),
    );
    expect(persistentDispatch).toContain('openCodePersistentAdapter.send({');
    expect(persistentDispatch).toContain('modelId: qualifiedModel');

    const routerTests = source('src/lib/ai/router.test.ts');
    expect(routerTests).toContain(
      "it('routes Model Foundry selections through OpenCode without a native bypass'",
    );
    expect(routerTests).toContain("model: 'foundry:job_12345'");
    expect(routerTests).toContain('expect(openCodeSend).toHaveBeenCalled');
  });

  it('keeps semantic plugin, skill, profile, learning, context, and file capability names fixed', () => {
    const protocol = source('src/lib/harness/toolGatewayProtocol.ts');
    for (const tool of [
      "'plugins.list'",
      "'plugins.run'",
      "'skills.list'",
      "'skills.load'",
      "'profile.allAboutMe.read'",
      "'profile.allAboutMe.update'",
      "'memory.learning.read'",
      "'memory.learning.update'",
      "'context.list'",
      "'context.read'",
      "'context.attach'",
    ]) {
      expect(protocol).toContain(tool);
    }
    expect(protocol).toContain("exactKeys(input, ['pluginId', 'operation'], ['input'])");
  });
});
