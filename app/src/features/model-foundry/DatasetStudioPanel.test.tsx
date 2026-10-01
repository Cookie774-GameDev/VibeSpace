import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DatasetStudioPanel } from './DatasetStudioPanel';

const NOW = '2026-07-14T12:00:00.000Z';

describe('DatasetStudioPanel', () => {
  it('reviews and creates an immutable consented manual dataset version', async () => {
    const onVersion = vi.fn();
    render(<DatasetStudioPanel projectId="project-1" now={() => NOW} onVersion={onVersion} />);
    fireEvent.change(screen.getByLabelText('Input'), { target: { value: 'Review this TypeScript function.' } });
    fireEvent.change(screen.getByLabelText('Expected output'), { target: { value: 'No side effects detected.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add approved example' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Approve dataset consent' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create immutable dataset v1' }));

    expect(await screen.findByText(/Immutable dataset v1 created/)).toBeTruthy();
    expect(onVersion).toHaveBeenCalledTimes(1);
    expect(onVersion.mock.calls[0][0].examples).toHaveLength(1);
  });

  it('quarantines likely secret material before staging', () => {
    render(<DatasetStudioPanel projectId="project-1" now={() => NOW} onVersion={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Input'), { target: { value: 'password=hunter22' } });
    fireEvent.change(screen.getByLabelText('Expected output'), { target: { value: 'Do not expose it.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add approved example' }));
    expect(screen.getByText(/quarantined pending review/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Redact 1 findings/ })).toBeTruthy();
  });

  it('quarantines secret-bearing seeds before local teacher generation', () => {
    render(<DatasetStudioPanel projectId="project-1" now={() => NOW} onVersion={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Input'), { target: { value: 'password=hunter22' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Approve local teacher draft' }));
    fireEvent.click(screen.getByRole('button', { name: 'Draft with promoted adapter' }));
    expect(screen.getByText(/seed is quarantined/i)).toBeTruthy();
  });

  it('creates a follow-on immutable dataset with lineage', async () => {
    const onVersion = vi.fn();
    render(<DatasetStudioPanel projectId="project-1" now={() => NOW} version={2} parentVersionId="vibecoder-dataset-v1" onVersion={onVersion} />);
    fireEvent.change(screen.getByLabelText('Input'), { target: { value: 'Review the next code sample.' } });
    fireEvent.change(screen.getByLabelText('Expected output'), { target: { value: 'Return a concise review.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add approved example' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Approve dataset consent' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create immutable dataset v2' }));
    expect(await screen.findByText(/Immutable dataset v2 created/)).toBeTruthy();
    expect(onVersion.mock.calls[0][0]).toMatchObject({ version: 2, parentVersionId: 'vibecoder-dataset-v1' });
  });
});
