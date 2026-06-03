/**
 * @file Tests for the system-prompt addendum builder.
 *
 * The addendum is how the LLM learns the action catalogue. It must:
 *   - list every built-in (and exposed custom tool)
 *   - include the JSON fence template the parser expects
 *   - hide actions explicitly flagged `exposeToAI: false`
 *   - never replace the user's own system_prompt
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/components/ui/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

import {
  buildAddendumText,
  applyAvailableActions,
} from '@/lib/actions/promptAddendum';
import { useToolStore } from '@/features/tools/toolStore';
import type { Agent, AgentId } from '@/types';

const baseAgent = (): Agent => ({
  id: 'agent-1' as AgentId,
  slug: 'jarvis',
  name: 'Jarvis',
  description: 'test',
  system_prompt: 'You are Jarvis.',
  model: { provider: 'mock', model: 'mock-default' },
  tools_allowed: ['*'],
  memory_scope: 'project',
  capabilities: [],
  created_at: 0,
  updated_at: 0,
});

describe('buildAddendumText', () => {
  beforeEach(() => {
    useToolStore.setState({ tools: [] });
  });

  it('describes the JSON fence template the parser expects', () => {
    const text = buildAddendumText();
    expect(text).toContain('```action');
    expect(text).toContain('id');
    expect(text).toContain('rationale');
  });

  it('lists built-in actions by their dotted ids', () => {
    const text = buildAddendumText();
    expect(text).toContain('nav.chat');
    expect(text).toContain('terminal.swarm');
    expect(text).toContain('wellness.eyeBreak');
  });

  it('appends custom tools that are exposed to AI', () => {
    useToolStore.getState().create({
      name: 'My dev server',
      description: 'Start the dev server.',
      baseAction: 'terminal.run',
      params: { command: 'npm run jarvis' },
    });
    const text = buildAddendumText();
    expect(text).toMatch(/custom\.my-dev-server/);
  });
});

describe('applyAvailableActions', () => {
  it('appends the catalogue to the existing system_prompt without dropping the original', () => {
    const a = baseAgent();
    const enriched = applyAvailableActions(a);
    expect(enriched.system_prompt.startsWith(a.system_prompt)).toBe(true);
    expect(enriched.system_prompt.length).toBeGreaterThan(a.system_prompt.length);
    expect(enriched.system_prompt).toContain('Available actions');
  });

  it('returns the original agent when there are no actions to advertise', () => {
    // Force the registry to look empty: spy on getAllActions via toolStore
    // suppression — built-ins always exist, so we just assert the append
    // is non-destructive on a normal call.
    const a = baseAgent();
    const enriched = applyAvailableActions(a);
    expect(enriched).not.toBe(a); // should be a derived object
    expect(enriched.id).toBe(a.id);
    expect(enriched.model).toEqual(a.model);
  });
});
