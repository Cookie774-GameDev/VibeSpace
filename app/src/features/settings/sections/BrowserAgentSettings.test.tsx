import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserAgentSettings } from './BrowserAgentSettings';

afterEach(cleanup);

describe('Browser Agent settings', () => {
  it('exposes the gateway, browser source, and approval controls', () => {
    render(<BrowserAgentSettings />);

    expect(screen.getByRole('heading', { name: 'Browser Agent' })).toBeTruthy();
    expect(screen.getByLabelText('Enable Browser Agent')).toBeTruthy();
    expect(screen.getByText(/VibeSpace MCP Gateway/)).toBeTruthy();
    expect(screen.getByLabelText('Ask before website submission')).toBeTruthy();
  });
});
