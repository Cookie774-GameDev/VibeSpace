import { describe, expect, it } from 'vitest';
import type { Route } from '@/features/navigation/routeSchema';
import { parseAssistantInput } from './parse';

describe('assistant navigation commands', () => {
  const cases: Array<[string, Route]> = [
    ['open chat', 'chat'],
    ['open canvas', 'canvas'],
    ['open preview', 'preview'],
    ['open browser', 'browser'],
    ['show terminals', 'terminal'],
    ['open kanban', 'kanban'],
    ['open agents', 'agents'],
    ['open model foundry', 'model-foundry'],
    ['open context', 'context'],
    ['open skills', 'skills'],
    ['show benchmarks', 'benchmarks'],
    ['open history', 'history'],
    ['open tools', 'tools'],
    ['open files', 'files'],
    ['open account', 'account'],
  ];

  it.each(cases)('parses %s as the %s route', (command, route) => {
    expect(parseAssistantInput(command)).toEqual({ kind: 'navigate', route });
  });

  it('preserves existing dedicated commands that navigate to Workbench and Schedule', () => {
    expect(parseAssistantInput('open workbench')).toEqual({
      kind: 'workbench',
      action: 'open',
    });
    expect(parseAssistantInput('open schedule')).toEqual({ kind: 'open_schedule' });
  });

  it('preserves selectors for detail routes', () => {
    expect(parseAssistantInput('open agent Jarvis')).toEqual({
      kind: 'navigate',
      route: 'agent-detail',
      selector: 'jarvis',
    });
    expect(parseAssistantInput('open project VibeSpace')).toEqual({
      kind: 'navigate',
      route: 'project-detail',
      selector: 'vibespace',
    });
  });
});
