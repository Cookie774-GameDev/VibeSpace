import { describe, expect, it } from 'vitest';
import { buildBrowserAgentPrompt } from './browserAgentPrompt';

describe('buildBrowserAgentPrompt', () => {
  it('bundles the selected agent and project Context Map without claiming a private bridge', () => {
    const prompt = buildBrowserAgentPrompt({
      agent: {
        name: 'Coder',
        description: 'Writes code',
        system_prompt: 'Make focused changes.',
        tools_allowed: ['files.read'],
        memory_scope: 'project',
        capabilities: ['code'],
      },
      projectName: 'VibeSpace',
      projectContext: 'Use TypeScript.',
      contextMap: {
        id: 'map-1',
        name: 'App map',
        sourceLabel: 'C:/VibeSpace',
        rootDir: 'C:/VibeSpace',
      } as never,
      formattedContextMap: 'Chat -> Composer',
    });

    expect(prompt).toContain('VibeSpace agent handoff: Coder');
    expect(prompt).toContain('Make focused changes.');
    expect(prompt).toContain('Use TypeScript.');
    expect(prompt).toContain('Chat -> Composer');
    expect(prompt).toContain('Do not claim that ChatGPT has direct VibeSpace tools');
  });
});
