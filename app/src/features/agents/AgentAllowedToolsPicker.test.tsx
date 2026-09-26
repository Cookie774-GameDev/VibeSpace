import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useToolStore } from '@/features/tools/toolStore';
import { getBuiltinActions } from '@/lib/actions/registry';
import { TOOL_GATEWAY_CATALOG } from '@/lib/harness/toolGatewayProtocol';
import { AgentAllowedToolsPicker } from './AgentAllowedToolsPicker';

afterEach(() => useToolStore.setState({ tools: [] }));

it('shows the gateway, built-in app actions, and saved custom tools', () => {
  useToolStore.setState({
    tools: [
      {
        slug: 'qa-tool',
        name: 'QA Tool',
        description: 'Test tool',
        baseAction: 'nav.chat',
        params: {},
        createdAt: 1,
        updatedAt: 1,
        published: null,
      },
    ],
  });
  render(<AgentAllowedToolsPicker value={[]} onChange={vi.fn()} />);
  fireEvent.focus(screen.getByLabelText('Allowed tools'));

  const choices = within(screen.getByRole('group', { name: 'VibeSpace tools' })).getAllByRole(
    'checkbox',
  );
  const labels = choices.map((choice) => choice.getAttribute('aria-label') ?? '');
  for (const tool of TOOL_GATEWAY_CATALOG)
    expect(labels.some((label) => label.includes(tool))).toBe(true);
  for (const action of getBuiltinActions())
    expect(labels.some((label) => label.includes(action.id))).toBe(true);
  expect(labels).toContain('QA Tool — custom.qa-tool');
});
