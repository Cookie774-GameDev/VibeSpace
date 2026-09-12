import { describe, expect, it } from 'vitest';
import { requestsReadOnlyContextTool } from './contextToolIntent';
const reference =
  '\n\nChat handoff from “Source” (chat-source)\n\nCurrent goal: verify references. File worked on: reference-fixture.txt.\n\nresults:\n- Completed the reference fixture.\n- Result: BLUE_HERON is the expected codeword.\n\nComplete visible transcript from the most recent three calendar days:\nRead the mapped files only and use vibespace_context.';
describe('chat references retain the requested operation', () => {
  it('does not force Context Map tools from quoted source history', () => {
    expect(
      requestsReadOnlyContextTool(
        'Review this context and continue from the latest truthful state.\n\nRead the attached chat reference. Reply with only its reference codeword.' +
          reference,
      ),
    ).toBe(false);
  });
  it('preserves explicit mapped-file research in the current user instruction', () => {
    expect(
      requestsReadOnlyContextTool(
        'Use vibespace_context to search the mapped files for the launch date.' + reference,
      ),
    ).toBe(true);
  });
});
