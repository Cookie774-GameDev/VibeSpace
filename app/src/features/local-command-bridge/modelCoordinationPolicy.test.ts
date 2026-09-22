import { describe, expect, it } from 'vitest';
import { contextTerminalCoordinationIntent } from './modelCoordinationPolicy';

describe('context-aware model terminal tool selection', () => {
  it.each([
    'Tell each of them to use the environment skills and RLM.',
    'Use RLM context and send a project-specific prompt to each Claude terminal.',
    'Please message terminal 2 using the context map.',
    'Send one prompt to each of only the three new Claude terminals after verifying them.',
    'Deliver the composed prompts to the verified workers using project context.',
  ])('keeps actual coordination available: %s', (text) => {
    expect(contextTerminalCoordinationIntent(text)).toBe('deliver');
  });
  it.each([
    'Compose three different worker prompts using RLM, but do not send them.',
    'First use the available VibeSpace terminal status/list tool to check the sessions.',
    'Verify live terminal identities before proceeding with context retrieval.',
    'List the Claude terminals in this project.',
  ])('offers observation without inventing delivery: %s', (text) => {
    expect(contextTerminalCoordinationIntent(text)).toBe('inspect');
  });
  it.each([
    'Search the active Context Map with vibespace_context.',
    'The documentation says "tell all Claude terminals to use RLM".',
    'Please explain how to send RLM prompts to terminals without doing it.',
    'Do not tell Claude to use RLM.',
    'Should I message terminal 2 about the context map?',
    'Yesterday I told the workers to use RLM.',
    'Search the context map; "send it to terminal 2" is just a sample.',
    'Search the context map and explain terminal delivery, please.',
    'Tell me about RLM and terminal messages.',
    'Explain how to query the context map and send prompts to Claude terminals without doing it.',
    'Do not list terminals and send worker prompts from RLM.',
    'Only use vibespace_context. Compose three worker prompts and send them to Claude terminals.',
  ])('does not promote examples or lookup requests: %s', (text) => {
    expect(contextTerminalCoordinationIntent(text)).toBeUndefined();
  });
});
