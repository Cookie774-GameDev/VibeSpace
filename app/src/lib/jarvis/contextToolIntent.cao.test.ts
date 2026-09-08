import { expect, it } from 'vitest';
import { requestsReadOnlyContextTool } from './contextToolIntent';
it.each(['do not run tools', 'do not use any tools', "don't call tools", 'never execute tools'])(
  'preserves a no-tool setup message: %s',
  (restriction) => {
    expect(
      requestsReadOnlyContextTool(
        `CAO game acceptance — platformer. You are the VibeSpace chat agent assigned only to the chat-platformer directory inside the selected games project. Jarvis CAO will send the detailed build instructions next. Preserve other agents and application source, work decisively, and verify actual results. For this setup message only, acknowledge your exact assigned directory in under 30 words; ${restriction} or edit files yet.`,
      ),
    ).toBe(false);
  },
);
it('still routes an affirmative request to read indexed evidence', () => {
  expect(
    requestsReadOnlyContextTool(
      'Read the indexed source files and verify the result. Do not write or edit files.',
    ),
  ).toBe(true);
});

it.each(['no Context Map', 'avoid Context Map investigation', 'do not use vibespace_context'])(
  'does not force retrieval from a negated reference: %s',
  (restriction) => {
    expect(
      requestsReadOnlyContextTool(
        `Create the game index.html now. Use normal file tools; ${restriction}, external assets, or subagents. Run deterministic checks.`,
      ),
    ).toBe(false);
  },
);

it.each(['no external assets/services, browser launch, Context Map, or subagents', 'without external services or Context Map retrieval', 'avoid external assets, Context Map, and subagents'])('preserves a build with a negated Context list: %s', restriction => {
 expect(requestsReadOnlyContextTool(`Create index.html now with three levels. Use file tools only—${restriction}. Run checks.`)).toBe(false);
});
it('retains an affirmative Context request after a separate restriction',()=>{
 expect(requestsReadOnlyContextTool('No external services. Use Context Map to find the source.')).toBe(true);
});
