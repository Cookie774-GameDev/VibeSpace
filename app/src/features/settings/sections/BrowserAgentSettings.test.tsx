import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserAgentSettings } from './BrowserAgentSettings';

afterEach(cleanup);

describe('Browser Agent settings', () => {
  it('keeps browser preferences without unsupported MCP approval switches', () => {
    render(<BrowserAgentSettings />);

    expect(screen.getByRole('heading', { name: 'Browser Agent' })).toBeTruthy();
    expect(screen.getByLabelText('Enable Browser Agent')).toBeTruthy();
    expect(screen.getByText(/VibeSpace MCP Gateway/)).toBeTruthy();
    expect(screen.queryByLabelText('Ask before website submission')).toBeNull();
    expect(screen.queryByLabelText('Ask before uploads or downloads')).toBeNull();
    expect(screen.queryByLabelText('Ask before sending, publishing, or purchasing')).toBeNull();
  });
});
