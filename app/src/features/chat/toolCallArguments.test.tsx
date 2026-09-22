import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ToolCallCard } from './ToolCallCard';

describe('historical tool-call argument display', () => {
  it('renders persisted safe details when the stored args object is empty', () => {
    render(
      <ToolCallCard
        call={{
          kind: 'tool_call',
          call_id: 'call-historical',
          tool: 'mcp_run',
          args: {},
          details: {
            arguments: {
              limit: 50,
              connectionId: 'n4-qa-fixture',
              toolName: 'qa_game_brief',
              filePath: 'C:\\Users\\viper\\secret\\game.json',
              authorization: 'Bearer top-secret-value',
            },
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /mcp_run/i }));

    expect(screen.getByText(/"limit": 50/)).toBeTruthy();
    expect(screen.getByText(/"connectionId": "n4-qa-fixture"/)).toBeTruthy();
    expect(screen.getByText(/"path": "game\.json"/)).toBeTruthy();
    expect(screen.getByText(/\[redacted: credentials\]/)).toBeTruthy();
    expect(screen.queryByText(/top-secret-value/)).toBeNull();
    expect(screen.queryByText(/C:\\Users\\viper\\secret\\game\.json/)).toBeNull();
    expect(screen.getByText(/call_id: call-historical/)).toBeTruthy();
  });

  it('keeps explicitly persisted nonempty args unchanged', () => {
    render(
      <ToolCallCard
        call={{
          kind: 'tool_call',
          call_id: 'call-current',
          tool: 'mcp_run',
          args: { limit: 3, path: 'already-safe.md' },
          details: { arguments: { limit: 50, path: 'other.md' } },
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /mcp_run/i }));

    expect(screen.getByText(/"limit": 3/)).toBeTruthy();
    expect(screen.getByText(/"path": "already-safe\.md"/)).toBeTruthy();
    expect(screen.queryByText(/"limit": 50/)).toBeNull();
    expect(screen.queryByText(/other\.md/)).toBeNull();
  });
});
