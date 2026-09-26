import { describe, expect, it } from 'vitest';

import { getBuiltinActions } from '@/lib/actions/registry';
import { interpretJarvisRequest } from './intentInterpreter';

const registered = new Set(getBuiltinActions().map((action) => action.id));

describe('Jarvis intent interpreter', () => {
  it('does not register generic plugin invocation actions', () => {
    expect(registered.has('plugin.call')).toBe(false);
    expect(registered.has('plugin.invoke')).toBe(false);
  });

  it.each([
    ['Hi', 'casual-conversation', []],
    ['Open Jarvis Actions.', 'app-navigation', ['settings.jarvisactions']],
    ['Rename this chat to Agent Testing.', 'app-configuration', ['chat.rename']],
    ['Show me which agents are currently active.', 'agent-execution', ['agent.status']],
    ['Check whether the Shopify plugin is connected.', 'plugin-use', ['plugin.status']],
    ['Cancel the running terminal workflow.', 'long-running-workflow', ['task.cancel']],
    ['Tell me a quick developer joke.', 'casual-conversation', []],
    ['Evaluate learned preferences after ten meaningful messages.', 'memory-update', []],
    ["Switch accounts and show the new account's learned preferences.", 'memory-update', []],
    [
      'Retry the same chat rename after the response is duplicated.',
      'app-configuration',
      ['chat.rename'],
    ],
    ['Switch to Gemini.', 'app-configuration', ['chat.model.switch']],
    ['Use Grok for this.', 'app-configuration', ['chat.model.switch']],
    ['Switch to Claude for this task.', 'app-configuration', ['chat.model.switch']],
    ['Use Grok for the next answer.', 'app-configuration', ['chat.model.switch']],
    ['Use a local model.', 'app-configuration', ['chat.model.switch']],
    ['Use my local model.', 'app-configuration', ['chat.model.switch']],
    ['Use the fastest connected model.', 'app-configuration', ['chat.model.switch']],
    ['Use Hive Balanced.', 'app-configuration', ['chat.model.switch']],
    ['Use the strongest coding model.', 'app-configuration', ['chat.model.switch']],
    ['Use the cheapest model that can handle this.', 'app-configuration', ['chat.model.switch']],
    ['Switch back.', 'app-configuration', ['chat.model.switch']],
    ['Go back to the default model.', 'app-configuration', ['chat.model.switch']],
  ])('classifies %s without inventing actions', (prompt, intent, actionIds) => {
    const result = interpretJarvisRequest(prompt);
    expect(result.intent).toBe(intent);
    expect(result.steps.map((step) => step.action)).toEqual(actionIds);
    expect(result.steps.every((step) => registered.has(step.action))).toBe(true);
  });

  it('leaves offline attached-file access to the selected native runtime', () => {
    const result = interpretJarvisRequest('In offline mode, summarize the attached local file.');

    expect(result.intent).toBe('file-work');
    expect(result.execution).toBe('automatic');
    expect(result.steps).toEqual([]);
    expect(result.response).toMatch(/local runtime.*attached file/i);
    expect(registered.has('files.read')).toBe(false);
  });

  it('keeps every model switch mutation behind the reviewed action approval', () => {
    const result = interpretJarvisRequest('Switch to Gemini.');

    expect(result.execution).toBe('approval-required');
    expect(result.steps).toEqual([
      {
        action: 'chat.model.switch',
        input: { request: 'Switch to Gemini.' },
      },
    ]);
  });

  it('extracts terminal count and official CLI without producing fake code', () => {
    const result = interpretJarvisRequest(
      'Open 10 terminals in my current project and start Claude in every safe new terminal.',
    );

    expect(result.intent).toBe('terminal-work');
    expect(result.execution).toBe('approval-required');
    expect(result.steps).toMatchObject([
      { action: 'terminal.ensure_total', input: { count: 10, cli: 'claude' } },
    ]);
    expect(result.steps).toHaveLength(1);
    expect(result.response).not.toMatch(/javascript|const |function /i);
  });

  it('honors create-only agent requests', () => {
    const result = interpretJarvisRequest(
      'Create a research agent for competitor analysis, but do not run it.',
    );
    expect(result.steps.map((step) => step.action)).toEqual(['agent.create']);
    expect(result.steps.some((step) => step.action === 'agent.run')).toBe(false);
  });

  it('plans one bounded action that runs and waits for two non-overlapping agents', () => {
    const result = interpretJarvisRequest(
      'Run two non-overlapping agents to inspect the chat and terminal systems.',
    );
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.action).toBe('agent.run_many');
    expect(JSON.parse(String(result.steps[0]?.input.tasksJson))).toHaveLength(2);
    expect(result.steps[0]?.deferred).not.toBe(true);
  });

  it.each([
    'Audit the entire repository deeply and map the authentication flow.',
    'Research this using at least five independent sources.',
    'Write a polished specialist implementation specification.',
    'Create the Canva landing-page design from this brand brief.',
  ])('routes valuable delegation through one reviewed bounded batch: %s', (request) => {
    const result = interpretJarvisRequest(request);

    expect(result.intent).toBe('multi-agent-orchestration');
    expect(result.execution).toBe('approval-required');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.action).toBe('agent.run_many');
    const tasks = JSON.parse(String(result.steps[0]?.input.tasksJson)) as unknown[];
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.length).toBeLessThanOrEqual(3);
    expect(result.response).not.toMatch(/chain.of.thought|reasoning step/i);
  });

  it.each([
    'Hello.',
    'Quick status question: what percent is complete?',
    'Open Settings.',
    'Switch to Gemini.',
    'Toggle the sidebar.',
  ])('does not delegate trivial work: %s', (request) => {
    const result = interpretJarvisRequest(request);

    expect(result.steps.some((step) => step.action === 'agent.run_many')).toBe(false);
  });

  it('does not override a more specific memory request with delegation', () => {
    const result = interpretJarvisRequest(
      'Remember that research reports should use several independent sources.',
    );

    expect(result.intent).toBe('memory-update');
    expect(result.steps).toEqual([]);
  });

  it('runs the declared Supabase read-only inspection without a write approval', () => {
    const result = interpretJarvisRequest(
      'Use the Supabase plugin to list my tables without changing anything.',
    );
    expect(result.execution).toBe('automatic');
    expect(result.steps.map((step) => step.action)).toEqual(['mcp.start', 'mcp.invoke']);
    expect(result.steps[1]?.input).toMatchObject({ toolName: 'list_tables', inputJson: '{}' });
  });

  it('never routes generic plugin tool requests to a model-selected plugin invocation', () => {
    const result = interpretJarvisRequest('Run the plugin tool and report its timeout.');
    expect(result.intent).toBe('plugin-use');
    expect(result.execution).toBe('explicit-approval-required');
    expect(result.steps).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/plugin\.(?:call|invoke)/);
  });

  it('never turns a destructive Supabase request into the automatic read-only path', () => {
    const result = interpretJarvisRequest('Use the Supabase plugin to delete all tables.');
    expect(result.execution).toBe('explicit-approval-required');
    expect(result.steps).toEqual([]);
  });

  it('attempts only MCP startup when a dependency is declared missing', () => {
    const result = interpretJarvisRequest('Use an MCP server whose executable is not installed.');
    expect(result.execution).toBe('automatic');
    expect(result.steps.map((step) => step.action)).toEqual(['mcp.start']);
  });

  it('does not invent a destructive project-delete action', () => {
    const result = interpretJarvisRequest('Delete every project.');
    expect(result.intent).toBe('destructive-action');
    expect(result.execution).toBe('explicit-approval-required');
    expect(result.steps).toEqual([]);
  });
});
