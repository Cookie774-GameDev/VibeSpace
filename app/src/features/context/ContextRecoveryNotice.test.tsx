import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ContextRecoveryNotice } from './ContextRecoveryNotice';

describe('ContextRecoveryNotice', () => {
  it('reports preserved recovery options without claiming available actions or exposing payloads', () => {
    render(
      <ContextRecoveryNotice
        recovery={{
          issueCount: 2,
          options: [
            {
              id: 'retry',
              label: 'Retry recovery',
              description: 'Validate the preserved source again and retry the migration.',
            },
            {
              id: 'restore_backup',
              label: 'Restore backup',
              description: 'Restore the preserved pre-migration backup.',
            },
            {
              id: 'export_then_discard',
              label: 'Export then discard',
              description: 'Export quarantined records before discarding their local copies.',
            },
          ],
        }}
      />,
    );

    expect(screen.getByRole('status').textContent).toMatch(/2 records need recovery/i);
    expect(screen.getByText('Context records need recovery')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Recovery actions are not available in this view.');
    expect(screen.queryAllByRole('button')).toEqual([]);
    expect(screen.getByRole('list', { name: 'Recorded recovery options' })).toBeTruthy();
    expect(screen.getByText('Retry recovery')).toBeTruthy();
    expect(screen.getByText('Restore backup')).toBeTruthy();
    expect(screen.getByText('Export then discard')).toBeTruthy();
    expect(screen.queryByText(/raw payload/i)).toBeNull();
  });

  it('renders nothing when no scoped recovery is required', () => {
    const { container } = render(<ContextRecoveryNotice recovery={null} />);
    expect(container.innerHTML).toBe('');
  });
});
