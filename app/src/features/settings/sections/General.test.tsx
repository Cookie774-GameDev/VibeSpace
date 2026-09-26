import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { General } from './General';

describe('General Agent Relay settings', () => {
  beforeEach(() => localStorage.clear());

  it('lets the user opt into Project scope and automatic check-ins', () => {
    render(<General />);

    const scope = screen.getByRole('combobox', { name: 'Agent Relay collaboration scope' });
    expect(scope).toHaveProperty('value', 'off');
    fireEvent.change(scope, { target: { value: 'project' } });
    fireEvent.click(
      screen.getByRole('switch', { name: 'Automatic Agent Relay check-ins and replies' }),
    );

    expect(localStorage.getItem('vibespace:agent-relay:settings:v1')).toContain(
      '"scope":"project"',
    );
    expect(localStorage.getItem('vibespace:agent-relay:settings:v1')).toContain(
      '"automaticParticipation":true',
    );
  });

  it('persists participation exclusions and does not claim an unverified connection', () => {
    render(<General />);
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Agent Relay excluded project and session IDs' }),
      {
        target: { value: 'project-private\nsession-private' },
      },
    );

    expect(localStorage.getItem('vibespace:agent-relay:settings:v1')).toContain(
      '"excludedParticipants":["project-private","session-private"]',
    );
    expect(
      screen.getByText('Live Relay health is not available in this settings session yet.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Test connection' })).toHaveProperty(
      'disabled',
      true,
    );
  });
});
